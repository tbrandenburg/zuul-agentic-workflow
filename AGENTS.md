# AGENTS.md — zuul-agentic-workflow

Guidance for AI coding agents (and humans) working in this repository.

## Purpose of this project

This is a **PoC**: prove that [Zuul](https://zuul-ci.org/) can orchestrate a
Git-backed AI agent pipeline (`planner → coder → reviewer`), gated entirely by
**deterministic validation** (`tool-validation`'s 9 ordered checks — schema,
patch application, allowlist, secrets, lint, tests), never by a model's own
self-assessment. A caller submits a task via `POST /runs`; Zuul drives every
job; the caller polls status and fetches a schema-valid `run-summary.json`
plus every artifact (patch, validation report, telemetry) by URL.

Read [`docs/PLAN.md`](docs/PLAN.md) before making any non-trivial change — it
is the single source of truth for _why_ things are built the way they are,
including every architectural decision, every research finding that
overturned an initial assumption, and every deviation from the original plan
with its justification. Do not re-derive decisions already recorded there;
extend the document instead of contradicting it silently.

## Hard constraints (do not relax these)

1. **No Gerrit, anywhere, in any phase.** `zuul-client enqueue-ref` against a
   single `git` driver connection is the only enqueue mechanism.
2. **Live E2E gates (`make e2e-*`) must never mock the model.** A gate that
   sets `"mock": true` is an integration test of the orchestration layer, not
   an E2E test — keep that distinction explicit in naming and docs.
3. **`make test` must never cost a model call.** Anything that does belongs
   under `make e2e-*`.
4. **Deterministic validation is the sole gate for progression.** The
   reviewer's verdict is recorded but is advisory only — it must never affect
   `final_verdict` or block downstream jobs.
5. **Cost/determinism is opt-in per request**, via the pushed `request.json`'s
   own `"mock"` field — never via separate always-scheduled job variants that
   run alongside real ones (a real defect from this exact mistake was found
   and fixed in Phase 3; see `docs/PLAN.md`'s Phase 3 notes before touching
   `zuul/zuul-config/zuul.d/{jobs,projects}.yaml`).

## How to develop here

### Stack

npm workspaces, TypeScript strict mode (`noUncheckedIndexedAccess`, no
`any`), Ajv-validated JSON Schemas as the single source of truth for
contracts (types are _generated_, never hand-written in parallel), Vitest,
Fastify, Ansible/Zuul YAML for orchestration.

### Everyday commands

```bash
make install    # npm install
make build      # tsc -b across every package/app — run before any Zuul job executes
make test       # unit + integration — must stay green, must never cost a model call
make lint       # eslint + prettier
make format     # prettier --write
```

### Zuul stack lifecycle

```bash
make phase0-up          # docker compose up: ZK+TLS, MariaDB, scheduler, web, executor, logs, gitserver
make phase0-seed        # seed the zuul-config/agent-runs bare repos
make check-config       # assert the semaphore name matches tenant config and job config
make phase1-reload      # after ANY zuul-config/** edit: push + zuul-scheduler full-reconfigure
                         # (a bare `docker compose restart scheduler` is NOT sufficient)
make phase0-down        # stop containers, keep volumes
make phase0-clean       # stop containers, remove volumes (full reset)
```

### Run API

```bash
make phase5-run-api        # start on :4100 (RUN_API_PORT to override), background, PID in /tmp/run-api.pid
make phase5-run-api-stop   # stop it
```

### Live E2E gates (cost real model tokens — this is intentional, per constraint 2 above)

```bash
make e2e-2      # agent-runtime, real opencode call
make e2e-3      # planner -> coder state passing
make e2e-4      # coder produces a real, validated patch
make e2e-5      # full 6-job chain via POST /runs (headline gate)
make e2e-6-1 … e2e-6-6   # the six hardening scenarios (docs/PLAN.md §11 Phase 6)
make e2e-6      # all six in sequence, pass/fail summary
make demo       # scripted happy-path + transcript
make e2e        # every Live E2E gate, phase 0 through 6, in order
```

Zero-cost equivalents: `phase3-e2e-mock`, `phase4-e2e-mock`,
`phase5-e2e-mock` — identical job graph, `agent-runtime --mock` instead of a
real model call.

### Before every commit

```bash
npm run build && npm run test && npm run lint
```

If you touched `zuul/zuul-config/**`, also re-run `make phase1-reload` and
whichever `make e2e-*`/`*-mock` gate exercises the job(s) you changed before
claiming the change works — a YAML/Jinja change that "looks right" has
repeatedly turned out not to be, in this repo's own history (see the
recurring gotchas below).

## Recurring gotchas in this repo (read before touching Zuul config)

These cost real debugging time to discover once; do not rediscover them:

- `type: initializer` jobs **must** be listed in `projects.yaml`'s job list,
  or they never run (the "auto-inserted" language only means every other
  listed job auto-depends on it, not that it's exempt from being listed).
- Never name a custom job `noop` — it collides with a Zuul built-in.
- Zuul's bubblewrap sandbox does **not** expose the executor container's own
  `PATH`/bind-mounts/dotfiles to trusted playbooks by default — anything a
  `command:` task needs beyond `/usr,/lib,/bin,/sbin` and the job's own dirs
  must be listed in `[executor] trusted_ro_paths`/`trusted_rw_paths`
  (`zuul/etc_zuul/zuul.conf`), **and** every such task needs explicit
  `PATH`+`HOME` in its own `environment:` block (a task missing just `HOME`
  fails identically to a missing trusted-path entry — always set both).
- Any `git`-invoking `command:` task touching `/repo` needs
  `GIT_CONFIG_COUNT`/`KEY_0`/`VALUE_0` (`safe.directory=*`) — `/repo` is
  host-owned and bubblewrap remaps unknown host UIDs to the overflow uid,
  triggering git's dubious-ownership protection.
- A config-project git push requires `zuul-scheduler full-reconfigure`
  (`make phase1-reload` does this) — a bare restart silently keeps serving
  the stale layout.
- `"localhost:8000"` does **not** resolve from inside the `executor`
  container's network namespace — trusted playbooks read artifacts via the
  shared `/srv/static/logs` volume path; only host-side scripts use the
  `http://localhost:8000/...` URL directly.
- Hardcoding `base_ref: "main"` in a script breaks the instant a job clones
  and checks out that ref on an unmerged feature branch — resolve it
  dynamically (`git -C /repo rev-parse --abbrev-ref HEAD`).
- `ExitCode.TIMEOUT` is retryable up to `max_attempts` — make sure
  `limits.timeout_ms * max_attempts` stays comfortably under the Zuul job's
  own `timeout:`, or Zuul's outer timeout masks `agent-runtime`'s own
  bounded, explicit exit-21 behavior with an opaque job-level `TIMED_OUT`.
- A stale/wedged `executor` or a semaphore stuck fully held by zombie
  builds (`curl http://localhost:9000/api/tenant/agents/semaphores`) both
  present as "nothing progresses" — `docker compose restart executor` and/or
  `zuul-client dequeue --tenant agents --pipeline agent-run --project
agent-runs --ref refs/heads/agent-runs` (repeat until the queue is empty)
  fix these; see `docs/RUNBOOK.md`'s troubleshooting table.

## Testing philosophy

50/30/20 unit/integration/E2E. Never mock in a Live E2E test — a gate that
needs a real model call must make one. A deliberately bad input must fail at
the _exact_ documented check with a precise message, not just "some
failure" — every `agent-tools` check and every `agent-runtime` exit code has
a dedicated test against a real fixture proving this. When a live scenario
can't be fully re-verified (e.g. an external rate limit), say so plainly in
`docs/PLAN.md` rather than declaring the gate passed on partial evidence.

## Where to make changes

- New JSON Schema / contract change → `packages/agent-contracts/schemas/`,
  regenerate types (`npm run build`), never hand-edit the generated
  `src/generated/*.d.ts`.
- New deterministic validation check → `packages/agent-tools/src/`, add to
  `validate.ts`'s ordered check list, add a unit test with a real git
  fixture per check (never a mock).
- New Zuul job → `zuul/zuul-config/zuul.d/jobs.yaml` + wire it in
  `projects.yaml`; give it a playbook under `zuul/zuul-config/playbooks/`;
  re-run `make phase1-reload` and the relevant gate before considering it
  done.
- New Run API endpoint → `apps/run-api/src/server.ts`; keep the Zuul
  REST/`zuul-client` calls injectable (see `RunApiConfig`) so unit tests
  never need a live Zuul stack.
