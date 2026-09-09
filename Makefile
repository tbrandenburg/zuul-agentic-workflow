.PHONY: phase0-up phase0-down phase0-seed phase0-token phase0-e2e-0 phase0-clean \
	check-config phase1-e2e-1 phase1-e2e-1-invalid phase1-reload

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
phase1-e2e-1:
	./zuul/scripts/e2e-1.sh

## Gate for Phase 1 task 1.4: an invalid run request causes the initializer
## to prune the whole graph (agent-smoke must NOT run).
phase1-e2e-1-invalid:
	./zuul/scripts/e2e-1.sh --invalid
