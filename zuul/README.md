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


## Phase 4 — Patch generation and deterministic validation

**STATUS: MOSTLY COMPLETE** (tasks 4.1-4.4, 4.7, 4.8; 4.5/4.6 deferred with
justification — see `docs/PLAN.md`'s Phase 4 section for the full writeup).
Reproducible via `make build && make phase1-reload && make phase4-e2e-mock`
(zero cost) and `make e2e-4` (real model, costs tokens).

Summary of what changed vs Phase 3:

- `sandbox/services/example/` — the tiny target repo the coder patches. Its
  `base_sha` is resolved **dynamically per run** by `init-run.yaml`
  (`git -C /repo rev-parse <base_ref>`), never hardcoded.
- `packages/agent-tools` — fully implemented (was an empty Phase-2 scaffold):
  `agent-tools validate` runs the 9 ordered, fail-fast checks from
  `docs/PLAN.md` §6 and writes `validation-report.json`/`.md`.
- `coder-agent`'s `run-agent.yaml` path now clones `/repo` (never the
  untrusted `agent-runs` project) into a throwaway per-build directory,
  checks out the pinned `base_sha`, gives opencode a real read-write
  checkout, and computes `patch.diff` via `git diff` afterwards.
- A new `tool-validation` job (depends on `coder-agent`) runs
  `agent-tools validate` and returns a namespaced `agent_result_validation`.

### Key findings from Phase 4

- **`"localhost:8000"` does not resolve from inside the `executor`
  container.** The `logs` service's port mapping is only reachable from the
  Docker host (or anything outside the compose network) — a trusted
  playbook running INSIDE `executor` cannot `curl`/`get_url` it. `executor`
  and `logs` already share the same named Docker volume at
  `/srv/static/logs`, though, so `validate-result.yaml` reads the coder's
  artifacts as plain files there instead of over HTTP — a simple
  `http://localhost:8000/<build>/... -> /srv/static/logs/<build>/...`
  string substitution on the already-namespaced `artifact_url`/`patch_url`
  values. No new networking, no new bind mount.
- **opencode's `edit` tool is `allow` by default** (verified against
  `https://opencode.ai/docs/permissions/`) — "most permissions default to
  allow", and `edit` is not one of the listed defaults-to-`ask`/`deny`
  exceptions (only `read` of `.env*` files, and `doom_loop`/
  `external_directory`, are non-`allow` by default). This meant the coder
  could be given a genuinely writable workspace directory and actually
  produce file edits **without** `--auto` (which plan §5.2/§9 explicitly
  forbid as "dangerous, do not use") and without any new `opencode.json`
  permission overrides.
- **`agent-runtime --mock` cannot simulate a real file edit, by design** —
  `packages/agent-runtime/src/mock.ts` replays a recorded NDJSON transcript
  and never touches the filesystem. Rather than inventing a new
  filesystem-writing code path inside `agent-runtime` just for the mock
  flag (which the CLI contract never promised), `run-agent.yaml` performs
  one small, deterministic file edit directly in the playbook when
  `agent_role == 'coder' and agent_mock` is true, so `phase4-e2e-mock`
  still exercises the identical patch-generation → `tool-validation` path
  end-to-end, at zero model cost.
- **`git clone <path>` only carries committed history, never uncommitted
  working-tree changes or `node_modules`.** Anything `agent-tools`'
  throwaway clones (or the coder's own workspace clone) need must already
  be committed to the branch `/repo`'s `base_ref` resolves to — this is a
  reason `base_sha` resolution and the coder/tool-validation flow could
  only be smoke-tested end-to-end by the coordinator AFTER committing this
  phase's changes, not by the implementing session itself (see the handoff
  notes for exactly what was and was not independently verified pre-commit).
- **Bubblewrap does not expose a bind-mounted `~/.gitconfig` to trusted
  playbooks either** (same visibility-gap class as Phase 3's PATH/mount
  finding). Git's "dubious ownership" check refuses any operation on `/repo`
  (host-owned, remapped to the bwrap overflow uid `65534` inside the
  sandbox's user namespace) even when running as root inside the sandbox.
  `GIT_CONFIG_COUNT`/`KEY_0`/`VALUE_0` env vars and inline `-c
  safe.directory=*` flags were tried first and were **not** sufficient
  alone — only adding `/root/.gitconfig` itself to
  `[executor] trusted_ro_paths` (`zuul.conf`) fixed it. Kept the env vars
  too, as harmless defense-in-depth.
- **Every `command:` task that shells out to `git` needs an explicit,
  consistent `environment: {PATH, HOME}`** — a task with only `PATH` set
  (missing `HOME`) fails the same dubious-ownership check in a way that
  looks identical to the gitconfig-visibility bug above, wasting debugging
  time distinguishing the two. Set both on every git-invoking task, always.
- **Hardcoding `base_ref: "main"` in a test/gate script breaks the moment a
  job starts actually cloning and checking out that ref on a feature branch
  that hasn't merged yet** — `zuul/scripts/e2e-0.sh`/`e2e-1.sh`/`e2e-3.sh`
  all had to switch to resolving `base_ref` dynamically from `/repo`'s
  current branch (`git -C /repo rev-parse --abbrev-ref HEAD`), matching the
  pattern `e2e-4.sh` used from the start.

## Phase 5 — Review, run summary, and the Run API

Adds `reviewer-agent` (advisory only — its verdict is recorded but never
gates progression) and `publish-run-summary` (soft-dependent on
`reviewer-agent`, so a summary is always published even if the reviewer
failed or was skipped) to the job graph, and implements the real Run API
HTTP server (`apps/run-api/src/server.ts`) that every prior phase's
`e2e-N.sh` scripts stood in for by pushing directly to the bare git repo.

Reproduce via:

```bash
make build
make phase1-reload
make phase5-run-api        # starts the Run API in the background on :4100
make phase5-e2e-mock       # zero-cost gate, drives the run via POST /runs
make e2e-5                 # real model, costs tokens
make phase5-run-api-stop
```

**Live-verified findings (this phase, on this host):**

- `GET /api/tenant/<tenant>/buildsets` (list) does **not** include a
  `builds` array — only `GET /api/tenant/<tenant>/buildset/<uuid>` (detail)
  does. `apps/run-api/src/server.ts`'s `resolveBuildsetSummary` therefore
  always makes two REST calls per status check, not one. This is not
  documented anywhere in the plan's §8/§13 REST API table and was only
  discovered by running the real server against the live stack.
- `zuul.buildset` (a plain Ansible fact — no REST call needed) **is** the
  buildset UUID (confirmed against Zuul's own job-content.html docs).
  `publish-summary.yaml` uses it directly for `run-summary.json`'s
  `buildset_uuid` and the buildset detail-page URL in `build_urls[]`.
- **Ansible's non-native Jinja2 templating silently stringifies numeric
  `set_fact` results**, even through explicit `| int`/`| float` filters,
  when the expression lives inside a multi-line `>-` folded block scalar.
  This is an Ansible behaviour (reproduced with a 4-line playbook run via
  plain `ansible-playbook`, entirely outside Zuul/bwrap) — NOT a Zuul or
  sandbox quirk. `publish-summary.yaml`'s telemetry totals therefore get a
  final `Number(...)` coercion in the companion Node validation script
  (`publish-summary.mjs`), the one point a real JSON number is actually
  required (Ajv's `type: integer`/`type: number` checks).
- A `regex_replace` pattern written as `'validation-report\\.json$'`
  (double-escaped, as if inside a YAML double-quoted string) does not
  match inside a plain Jinja template string — the correct pattern is a
  single backslash, `'validation-report\.json$'`. This produced a subtly
  wrong `artifact_urls[]` (the `.json` report listed twice, the `.md`
  report never referenced) until caught by inspecting the live output.
- Any new `command:`/`copy:` task under `/tmp/{{ zuul.build }}/...` must
  create that directory first, exactly like every existing task in
  `run-agent.yaml` already does — `publish-summary.yaml`'s very first live
  run failed with "Destination directory does not exist" from a missing
  `file: {state: directory}` task, the exact same class of omission
  documented in earlier phases for other paths.
- **A stale/wedged `executor` container can cause every job's `pre-run` to
  fail silently** (`RETRY` → `RETRY_LIMIT`, empty console output,
  `log_url: null`), reproducing even against previously-passing,
  completely untouched playbooks (`e2e-1.sh`). `docker compose restart
  executor` (not `down -v`) resolved it immediately. Not a Phase 5 code
  defect — flagged here so a future session recognises the symptom
  quickly rather than assuming a config regression.
- `GET /buildsets` supports `?ref=&newrev=` filtering exactly as documented
  (plan §13); `Run API`'s `GET /runs/:id`/`/runs/:id/summary` use this to
  resolve a `run_id` to its buildset without re-deriving it from git
  history.

**Port choice:** the Run API listens on **4100** by default
(`RUN_API_PORT` env var to override) — chosen after checking `ss -tln` for
already-bound ports on this host (8000 `logs`, 9000 `zuul-web`, plus
several unrelated dev services on 3000/3010/5173/8010/8888/8890/9090).

**Coordinator's live `e2e-5` run (post-handoff):** first attempt failed at
`planner-agent` (exit 30, the same real-model non-determinism documented in
Phases 3/4, not a Phase 5 defect); one retry PASSED with real telemetry
(`tokens_input=1349`, `tokens_output=919`). On the *failing* attempt,
`publish-run-summary` was `SKIPPED` despite its `soft: true` dependency on
`reviewer-agent` — the soft link tolerated its direct parent being
skipped, but the skip originated several levels upstream
(`planner-agent` → `coder-agent` → `tool-validation` → `reviewer-agent`,
all hard dependencies), and that did not trigger `publish-run-summary`
anyway. "A caller always gets a summary" is therefore not fully guaranteed
by the current wiring — noted for a future phase, not fixed here (a retry
was the plan-sanctioned response to this specific failure class).

