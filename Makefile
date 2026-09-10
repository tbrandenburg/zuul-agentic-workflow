.PHONY: phase0-up phase0-down phase0-seed phase0-token phase0-e2e-0 phase0-clean \
	check-config phase1-e2e-1 phase1-e2e-1-invalid phase1-reload \
	install build test lint format e2e-2 \
	e2e-3 phase3-e2e-mock phase3-prove-no-stdout-leak \
	e2e-4 phase4-e2e-mock

COMPOSE := docker compose -p zuul-poc -f zuul/docker-compose.yaml

## Bring up the Phase 0 infrastructure spike stack (ZK, MariaDB, scheduler,
## web, executor, logs, gitserver) with pinned Zuul 14.2.0 images.
phase0-up:
	mkdir -p zuul/gitserver-repos
	$(COMPOSE) up -d certs-init
	sleep 5
	$(COMPOSE) up -d --build

## Seed the zuul-config (config-project) and agent-runs (untrusted-project)
## bare repos served by the gitserver container.
phase0-seed:
	./zuul/scripts/seed-repos.sh

## Mint a fresh JWT for enqueue-ref/enqueue calls (strips the "Bearer " prefix).
phase0-token:
	$(COMPOSE) exec scheduler zuul-admin create-auth-token \
		--auth-config zuul_operator --user run-api --tenant agents \
		--expires-in 86400 2>/dev/null | sed 's/^Bearer //'

## Gate E2E-0: enqueue-ref -> buildset -> executor-only job SUCCESS.
## Requires the stack to be up and seeded. Prints the buildsets JSON.
phase0-e2e-0:
	./zuul/scripts/e2e-0.sh

phase0-down:
	$(COMPOSE) down

phase0-clean:
	$(COMPOSE) down -v

## Push zuul-config changes to the bare repo and force the scheduler to
## re-parse it. NOTE: restarting the scheduler process is NOT sufficient -
## on startup it loads the last-known layout from ZooKeeper for speed, so a
## config-project change requires an explicit full-reconfigure (discovered
## empirically in Phase 1; see zuul/README.md).
phase1-reload:
	./zuul/scripts/seed-repos.sh
	$(COMPOSE) exec scheduler zuul-scheduler full-reconfigure
	sleep 3

## Assert the global semaphore name matches between the tenant config
## (etc_zuul/main.yaml) and the job config (zuul-config/zuul.d/jobs.yaml) -
## plan §1.5/§11 task 1.5. An undefined semaphore name silently creates an
## implicit max:1 semaphore instead of erroring, so this is a Makefile-level
## assertion rather than relying on Zuul to catch a typo.
check-config:
	@grep -q "agent-model-concurrency" zuul/etc_zuul/main.yaml || \
		(echo "check-config FAILED: 'agent-model-concurrency' not found in zuul/etc_zuul/main.yaml" >&2 && exit 1)
	@grep -rq "agent-model-concurrency" zuul/zuul-config/zuul.d/jobs.yaml || \
		(echo "check-config FAILED: 'agent-model-concurrency' not found in zuul/zuul-config/zuul.d/jobs.yaml" >&2 && exit 1)
	@echo "check-config OK: agent-model-concurrency present in tenant config and job config"

## Gate for Phase 1 tasks 1.1-1.3: initializer validates+publishes an
## artifact, base job's log_url plumbing works end-to-end.
## Phase 3 note: this pipeline now also runs planner-agent/coder-agent on
## every push, but e2e-1.sh's request.json sets "mock": true so they run
## agent-runtime --mock (zero model cost, deterministic) - this gate stays
## free and non-flaky, as it was before Phase 3 (see docs/PLAN.md Phase 3
## notes for the cost-coupling defect this fixes).
phase1-e2e-1:
	./zuul/scripts/e2e-1.sh

## Gate for Phase 1 task 1.4: an invalid run request causes the initializer
## to prune the whole graph (agent-smoke must NOT run).
phase1-e2e-1-invalid:
	./zuul/scripts/e2e-1.sh --invalid

## --- Phase 2: npm workspace targets (pure Node/TS, no Docker/Zuul) ---

## Install all npm workspace dependencies.
install:
	npm install

## Build all workspaces (generates agent-contracts types, then tsc -b).
build:
	npm run build --workspace @repo/agent-contracts
	npx tsc -b

## Run all unit + integration tests across workspaces. Uses --mock
## everywhere; NEVER invokes a real model (plan §11.8).
test:
	npm run test --workspaces --if-present

## eslint (TS-aware, no `any`) + prettier --check across the workspace.
lint:
	npx eslint .
	npx prettier --check .

## Auto-fix formatting.
format:
	npx prettier --write .

## Gate E2E-2 (non-mocked): agent-runtime run --role planner against the
## REAL opencode CLI. Costs real model tokens - never run as part of `test`.
e2e-2:
	./packages/agent-runtime/scripts/e2e-2.sh

## --- Phase 3: planner -> coder state passing (zuul/zuul-config/**) ---

## Gate E2E-3 (non-mocked): planner-agent -> coder-agent two-job chain runs
## inside Zuul against the REAL model for BOTH roles (trivial task, per
## plan §10 cost discipline). Costs real model tokens for two roles - never
## run as part of `test`/CI without deliberate intent. Retries up to 3 times:
## a real model occasionally does not emit the required fenced json block
## on a given call (exit 30) - documented model non-determinism, not an
## infra defect (same acceptance as Phase 4's own "permits one retry").
e2e-3:
	for i in 1 2 3; do ./zuul/scripts/e2e-3.sh && exit 0; echo "e2e-3 attempt $$i failed, retrying..." >&2; done; exit 1

## Genuinely zero-model-cost inner loop for the same two-job chain: pushes
## request.json with "mock": true, so planner-agent/coder-agent themselves
## invoke `agent-runtime --mock` (see run-agent.yaml/init-run.yaml) instead
## of a separate always-scheduled "-mock" job pair. Requires
## `make phase1-reload` after any zuul-config change and the repo built
## (`make build`) since the executor's /repo mount is read-only.
phase3-e2e-mock:
	./zuul/scripts/e2e-3.sh --mock

## Task 3.5: prove the coder never reads the planner's raw stdout - see
## zuul/scripts/prove-no-stdout-leak.sh for the exact reproduction and its
## documented reasoning/limitations.
phase3-prove-no-stdout-leak:
	./zuul/scripts/prove-no-stdout-leak.sh

## --- Phase 4: patch generation and deterministic validation ---

## Gate E2E-4 (non-mocked): real coder-authored patch.diff survives all 9
## `agent-tools validate` checks (tool-validation job), independently
## re-verified (git apply --check + report re-parse), and
## sandbox/services/example is proven byte-identical before/after (task
## 4.7). Costs real model tokens. Permits exactly ONE retry, ONLY when the
## first failing check is specifically "patch-applies" (plan-sanctioned
## exception for real-model non-determinism - see zuul/scripts/e2e-4.sh's
## header comment). Requires `make build` + `make phase1-reload` first.
e2e-4:
	./zuul/scripts/e2e-4.sh

## Genuinely zero-model-cost inner loop for the same planner -> coder ->
## tool-validation chain: pushes request.json with "mock": true. planner-
## agent/coder-agent invoke agent-runtime --mock (zero cost); coder-agent's
## playbook still performs one real, deterministic file edit + `git diff`
## (see run-agent.yaml) so tool-validation exercises the identical patch-
## validation path against a real (if trivial) patch, at zero cost.
phase4-e2e-mock:
	./zuul/scripts/e2e-4.sh --mock
