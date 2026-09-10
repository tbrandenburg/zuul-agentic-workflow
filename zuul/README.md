# Zuul Phase 0-1 infrastructure

Implements `docs/PLAN.md` §11 Phase 0 and Phase 1. A minimal, pinned (14.2.0)
Zuul stack proving:

- a single `git` driver connection can host both a config-project
  (`zuul-config`) and an untrusted-project (`agent-runs`);
- `zuul-client enqueue-ref` with real, non-zero `oldrev`/`newrev` produces a
  buildset;
- an executor-only job (no `nodeset`, no launcher, no node) runs to SUCCESS.

No Gerrit anywhere. No launcher/node in this phase (introduced in Phase 4).

## Layout

| Path | Purpose |
|---|---|
| `docker-compose.yaml` | zk, mysql, scheduler, web, executor, logs, gitserver, certs-init |
| `etc_zuul/` | `zuul.conf`, `main.yaml` (tenant), `zoo.cfg`, cert-wait helper |
| `zuul-config/` | Config-project source (pipeline + jobs), pushed to the bare repo by `scripts/seed-repos.sh` |
| `gitserver-image/` | Minimal Alpine `git daemon` (with `receive-pack`) serving `git://gitserver/<repo>` |
| `gitserver-repos/` | Generated bare repos (`zuul-config.git`, `agent-runs.git`) — gitignored, always reproducible |
| `logs-image/` | Apache log server (copied verbatim from the upstream Zuul example) |
| `tools/` | `zk-ca.sh` + `openssl.cnf` (copied verbatim from the upstream Zuul 14.2.0 sdist) |
| `scripts/seed-repos.sh` | Idempotently (re)creates the bare repos and pushes `zuul-config` content |
| `scripts/e2e-0.sh` | Gate E2E-0: push a run commit, enqueue-ref, poll for buildset SUCCESS |

## Quickstart

```bash
make phase0-up      # docker compose up (pulls/builds images, generates ZK TLS certs)
make phase0-seed     # seed the bare repos served by gitserver
make phase0-e2e-0    # gate: enqueue-ref -> buildset -> executor-only job SUCCESS

make phase1-reload         # push zuul-config + force scheduler full-reconfigure
make check-config          # assert the semaphore name matches tenant vs job config
make phase1-e2e-1          # gate: initializer validates+publishes an artifact
make phase1-e2e-1-invalid  # gate: invalid request prunes the whole graph
```

Web UI: http://localhost:9000/t/agents/buildsets (anonymous read, no login).

## Phase 1: base job lifecycle + initializer

- `base` (`zuul-config/zuul.d/jobs.yaml`) now has a real `pre-run`
  (`playbooks/base/pre.yaml`), `post-run: [cleanup.yaml (cleanup: true),
  post-logs.yaml]` lifecycle. `post-logs.yaml` copies the **entire**
  `zuul.executor.log_root` (not just a custom artifacts subdir) to
  `/srv/static/logs/{{ zuul.build }}/` and returns `zuul.log_url` - this is
  what makes both the web UI's Console/Logs tabs *and* our own artifacts work
  from the same copy step.
- `initialize-agent-run` (`type: initializer`, `playbooks/init-run.yaml`)
  identifies the triggering commit's `runs/<run_id>/request.json` via
  `git diff-tree --no-commit-id --name-only -r {{ zuul.newrev }}` run against
  the checked-out `agent-runs` worktree at
  `{{ zuul.executor.work_root }}/{{ zuul.project.src_dir }}`, validates the
  required keys (`task`/`repo`/`base_ref`), and either publishes
  `run-request.json` as an artifact or prunes the whole graph with
  `zuul_return: data: zuul: child_jobs: []` (plus a `fail:` task for a clear
  console message).
- Global semaphore `agent-model-concurrency` (`max: 2`) is declared in
  `etc_zuul/main.yaml` and granted to the tenant, but **deliberately not yet
  attached to any job** - no job invokes a model until Phase 3's
  planner/coder. `make check-config` asserts the name is present in both
  places so a future typo is caught immediately rather than silently creating
  an implicit `max: 1` semaphore.
- Run API's `git-writer` (plan §11 task 1.7, risk R14) is **deferred to
  Phase 2**, where the npm workspace it belongs in gets scaffolded.
  `zuul/scripts/e2e-1.sh` does a plain unsynchronized `git clone`+`push` per
  invocation, adequate for a single-invocation gate but not for concurrent
  `POST /runs`.

## Troubleshooting notes found in Phase 1

- **A config-project change requires an explicit
  `zuul-scheduler full-reconfigure`, not just a process restart.** On
  startup, the scheduler loads the tenant's last-known layout from ZooKeeper
  for speed ("Using system config from Zookeeper" in its log) rather than
  re-parsing from git. `docker compose restart scheduler` after a
  `zuul-config` push looks like it worked (clean "Config priming complete",
  no errors) but silently keeps serving the stale layout. The git driver's
  60s poll does **not** appear to trigger a reconfiguration on its own either
  (at least not within several poll intervals in this setup). The fix:
  `docker compose exec scheduler zuul-scheduler full-reconfigure` after every
  `zuul-config` push - wired into `make phase1-reload`.
- **`type: initializer` jobs must still be listed in the project stanza's job
  list.** The plan's original research (§1.2) claimed the opposite based on a
  literal reading of "always automatically inserted at the start of the job
  graph"; empirically, an initializer job absent from `projects.yaml`'s
  `jobs:` list simply never runs. What "auto-inserted" actually means is that
  Zuul wires it as an implicit dependency of every other job in the graph, so
  you don't need `dependencies: [initialize-agent-run]` on each of them - see
  the corrected §1.2 in `docs/PLAN.md`.
- **An unquoted colon-plus-space inside an Ansible task `name:` string breaks
  YAML parsing** (e.g. `name: ... post-run cleanup: true playbook`) - the
  parser reads it as a nested mapping key and fails with a cryptic "mapping
  values are not allowed in this context" pointing at the `name:` line
  itself, not the actual colon. Quote the whole string if it must contain a
  literal colon.
- **Apache's `Header set` directive does not apply to its own generated error
  responses (404, etc.)** - only `Header always set ...` does. This matters
  because the Zuul web UI's Console tab always requests
  `job-output.json.gz` first and falls back to `job-output.json`; without
  `Header always set Access-Control-Allow-Origin "*"` on the logs server, the
  404 for the (by default, un-produced) `.gz` variant is a CORS console
  error even though the plain `.json` fallback succeeds. We eliminated the
  404 entirely by having `post-logs.yaml` also pre-compress
  `job-output.json` to `job-output.json.gz` with Ansible's `archive` module.
- **`zuul.project.src_dir` / `zuul.executor.work_root`** are the two facts
  needed to locate a triggering project's checkout from a `hosts: localhost`
  trusted playbook: the full path is
  `{{ zuul.executor.work_root }}/{{ zuul.project.src_dir }}`. Discovered via a
  temporary `debug: var=zuul` task (kept as a documented technique here, not
  as leftover code).

## Known Phase-0-only limitations (intentionally deferred)

- `[auth zuul_operator] secret=` is a short PoC placeholder, not
  production-grade. Revisit before any non-local deployment.
- No log volume wiring yet (`zuul.log_url` / artifacts) — Phase 1 task 1.2.
- No `agent-runner` node/launcher — Phase 4.
- `agent-smoke` job is a throwaway smoke-test job; Phase 1 replaces it with
  `initialize-agent-run` (`type: initializer`).

## Troubleshooting notes (found the hard way)

- Alpine's `git` package does **not** include `git daemon` — install the
  separate `git-daemon` package.
- `git daemon` running as root refuses to serve repos owned by another UID
  ("dubious ownership") — add `git config --system --add safe.directory '*'`
  in the image.
- Even executor-only (no-`nodeset`) jobs need `[executor] private_key_file`
  set to a real, `chmod 600` private key, or the executor's SSH-agent setup
  fails before the job ever runs.
- Do **not** name a custom job `noop` — Zuul has a reserved built-in job of
  that exact name and defining your own causes an obscure internal
  `KeyError`/`AttributeError` in the tenant parser instead of a clear
  "duplicate job" error.
- ZooKeeper TLS is mandatory in Zuul 14 (no plaintext fallback) — use the
  upstream `tools/zk-ca.sh` self-signed CA script rather than reinventing it.
- **Never delete-and-recreate a bind-mounted host directory while its
  container is running.** Linux bind mounts pin the inode, not the path; if
  you `rm -rf` and `mkdir` the host side afterward, the container keeps
  serving the old (unlinked) directory and silently shows it as empty.
  Recreate the container (`docker compose up -d --force-recreate <service>`)
  after any such host-side directory replacement, or better, never replace
  the directory once a container has mounted it — only edit its contents in
  place (`scripts/seed-repos.sh` and `make phase0-up`'s `mkdir -p` follow this
  rule).


## Phase 3: planner -> coder state passing

```bash
make e2e-3                          # gate: real planner-agent -> coder-agent chain (costs model tokens)
make phase3-e2e-mock                # fast, zero-cost inner loop (same jobs, request.json "mock": true)
make phase3-prove-no-stdout-leak    # task 3.5: coder never reads the planner's raw stdout
```

- New abstract `agent` job (`parent: base`, `zuul.d/jobs.yaml`) finally
  attaches the `agent-model-concurrency` global semaphore (deferred since
  Phase 1) and carries per-build `agent_input_path`/`agent_output_path`/
  `agent_workspace_path` under `/tmp/{{ zuul.build }}/...` - a bare
  `/tmp/agent-input.json` would risk collision if two agent jobs (semaphore
  `max: 2`) ran concurrently on the same executor.
- `planner-agent`/`coder-agent` run on every push to `agent-runs` - see
  `zuul.d/projects.yaml`. `initialize-agent-run`'s implicit dependency-on-
  every-listed-job (Phase 1 finding) covers both with no explicit
  `dependencies: [initialize-agent-run]` needed, verified via the buildset's
  job graph in the web UI after a real `e2e-3` run.
- **Cost/determinism is opt-in per push, not per job variant.** The pushed
  `request.json` may set an optional `"mock": true` field; `init-run.yaml`
  passes it through as `agent_result_initialize.mock`, and `jobs.yaml`'s
  `agent_mock` var reads it, so the SAME `planner-agent`/`coder-agent` jobs
  invoke `agent-runtime --mock` when asked to. **This replaced an earlier
  design** with separate `planner-agent-mock`/`coder-agent-mock` job
  variants that ran unconditionally *alongside* the real jobs on every push
  (a single Zuul project stanza has no per-push conditional job selection) -
  that design never actually avoided model cost, since the real jobs still
  ran (and could still fail) regardless of which pair a test script chose to
  assert on. Caught by the coordinator during review (a real `planner-agent`
  FAILURE was silently ignored by a "PASSED" mock-gate result); see
  `docs/PLAN.md`'s Phase 3 notes for the full story. `phase0-e2e-0`,
  `phase1-e2e-1`, and `e2e-3.sh --mock` all set `"mock": true` and are
  zero-cost/deterministic again; only `e2e-3` (no flag) and `e2e-2` spend
  real tokens.
- `run-agent.yaml` builds the `agent-input.json` manifest entirely from Zuul
  vars: `run_id`/`task`/`repo`/`base_ref` from the initializer's (now
  extended) `agent_result_initialize`, and `coder-agent`'s
  `upstream_results` entirely from `agent_result_planner` - never by
  re-reading `runs/<id>/request.json` or any stdout/console log.
- `agent-input.schema.json`'s `upstream_results[].artifact_url` requires
  `format: "uri"` (an absolute URL) - a relative `artifacts/planner/...`
  path fails Ajv's `ajv-formats` check. `run-agent.yaml` composes the full
  `http://localhost:8000/{{ zuul.build }}/artifacts/...` URL instead (same
  log-server base URL `base/post-logs.yaml` already hardcodes for
  `zuul.log_url`).
- Independent schema validation (task 3.4, plan §7.6) is a small standalone
  `.mjs` script written per-build that imports `@repo/agent-contracts`'s
  already-built `dist/index.js` directly - deliberately not
  `packages/agent-tools` (still an intentionally-empty Phase-4 scaffold).
- Run IDs pushed by any script targeting this pipeline must be ULID-shaped
  (`^[0-9A-HJKMNP-TV-Z]{26}$`, the `runs/<run_id>/` directory name itself,
  not just the JSON body's own `run_id` field) - once `planner-agent`
  actually constructs a schema-validated `agent-input.json`, a non-ULID
  `run_id` (e.g. Phase 0's original `e2e0-<timestamp>` scheme) fails exit 10.


### Troubleshooting notes found in Phase 3

- **Zuul's bubblewrap sandbox does not inherit the container's `PATH`, even
  for trusted-project playbooks.** `docker exec <executor> node --version`
  working is not evidence that a Zuul job's `command: node ...` task will
  work - `bwrap` only binds `/usr`, `/lib`, `/bin`, `/sbin` plus the job's own
  work/ansible dirs by default. Needed **both**: (1)
  `[executor] trusted_ro_paths=/repo:/opt/node:/opt/opencode-bin` in
  `zuul.conf` (colon-separated, NOT comma - a comma silently becomes one
  bogus combined bind path, surfaced only via `bwrap: Can't find source path
  ...` in `-d` debug executor logs, with no error at the Ansible/Zuul level
  at all - the build just shows `RETRY`/`RETRY_LIMIT` with an empty
  `job-output.json`); (2) an explicit `environment: {PATH: ..., HOME: /root}`
  on every `command:` task invoking `node`/`opencode`, since Ansible's own
  environment-scrubbing is independent of the executor process's shell PATH,
  and `node:child_process.spawn('opencode')` needs `PATH` in *its own*
  `process.env` to find the binary.
- **A build showing `RETRY`/`RETRY_LIMIT` with no console output and no
  `error_detail` in the API almost always means the *pre-run* playbook
  failed to even start** (bwrap setup error, missing bind path, etc.) - the
  Zuul API gives no clue; restart the executor with `-f -d` (debug logging)
  temporarily to see the actual `bwrap:` or `Ansible output:` line, then
  revert to `-f` once fixed.
- **A host bind-mounted directory owned by a different UID than the
  sandboxed job's effective identity can cause `PermissionDenied`** even on
  paths already listed as `rw` - `~/.local/share/opencode` (host uid 1000)
  needed `chmod -R o+rwX` before `opencode.log` could be written from inside
  a job. PoC-only workaround, not a production pattern.
- **Real-model output-format compliance is task-description-sensitive, not
  just "sometimes flaky".** A task description that invites the model to
  explore a nonexistent repository (e.g. "E2E-1 smoke test" against
  `sandbox/services/example`) reliably burns the model's turn budget on tool
  calls before it emits the required fenced ` ```json ` block (exit 30 -
  `no fenced json block found`), observed on ~10 consecutive real attempts.
  A trivial, exploration-free description ("Say hello in one sentence.",
  already used by `e2e-2`) does not exhibit this and passed first-try. When
  a gate couples real model jobs into a shared pipeline, prefer the
  proven-reliable trivial description over a topical-but-untested one, even
  for an otherwise-content-irrelevant smoke test.
- **Leftover background `docker exec` processes from manual debugging can
  linger indefinitely and contend for CPU with the next real Zuul-triggered
  model call** (a killed local shell/timeout does NOT kill the remote
  container process it started) - `docker exec <c> pkill -9 -f opencode`
  before re-running a gate if you've been debugging manually in the same
  container.
