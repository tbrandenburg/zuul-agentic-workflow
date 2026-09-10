# RUNBOOK — Zuul Agentic Workflow PoC

Operational quick-start for someone who has never touched this repository
before. For implementation details, design rationale, and troubleshooting
history, see [`zuul/README.md`](../zuul/README.md) and
[`docs/PLAN.md`](PLAN.md).

## 1. Prerequisites

- Docker + Docker Compose v2
- Node.js 24+, npm 11+
- `zuul-client` CLI on `PATH` (`pip install zuul-client`)
- `opencode` CLI on `PATH`, authenticated (`opencode auth login`), with a
  working model configured (this repo defaults to `opencode/big-pickle`)
- Free ports: **9000** (Zuul web/API), **8000** (log server), **4100**
  (Run API — override with `RUN_API_PORT`). Check first:
  `ss -tln | grep -E ':(9000|8000|4100) '` should print nothing.

## 2. Bring up the stack from scratch

```bash
git clone <this-repo> && cd zuul-agentic-workflow
npm install
npm run build                # builds all packages/apps (dist/ output)

make phase0-up                # docker compose up: ZK+TLS, MariaDB, scheduler,
                               # web, executor, logs, gitserver (pinned 14.2.0)
make phase0-seed               # seeds the zuul-config/agent-runs bare repos
make check-config              # sanity check: semaphore name matches everywhere
```

Wait ~30s after `phase0-up` for all containers to report healthy
(`docker compose -p zuul-poc -f zuul/docker-compose.yaml ps`), then confirm
the scheduler loaded the config cleanly:

```bash
docker compose -p zuul-poc -f zuul/docker-compose.yaml logs scheduler --since 1m | grep -i error
# expect no output
```

Start the Run API (the primary way to submit runs from Phase 5 onward):

```bash
make phase5-run-api            # starts on :4100 in the background (PID in /tmp/run-api.pid)
curl http://localhost:4100/healthz    # {"status":"ok"}
```

## 3. Submit a run

```bash
curl -s -X POST http://localhost:4100/runs \
  -H 'Content-Type: application/json' \
  -d '{
    "task": "Add a one-line comment above the add function in index.js explaining what it does.",
    "repo": "sandbox/services/example",
    "base_ref": "main"
  }'
```

Expected response (HTTP 202):

```json
{ "run_id": "01ARZ3NDEKTSV4RRFFQ69G5FAV", "newrev": "<sha>", "status_url": "/runs/01ARZ3NDEKTSV4RRFFQ69G5FAV" }
```

Poll for status (repeat until `"status"` is no longer `"PENDING"`):

```bash
curl -s http://localhost:4100/runs/01ARZ3NDEKTSV4RRFFQ69G5FAV | python3 -m json.tool
```

A terminal response looks like:

```json
{
  "status": "SUCCESS",
  "buildset_uuid": "...",
  "builds": [
    {"job_name": "initialize-agent-run", "result": "SUCCESS", "log_url": "http://localhost:8000/.../"},
    {"job_name": "planner-agent", "result": "SUCCESS", "log_url": "..."},
    {"job_name": "coder-agent", "result": "SUCCESS", "log_url": "..."},
    {"job_name": "tool-validation", "result": "SUCCESS", "log_url": "..."},
    {"job_name": "reviewer-agent", "result": "SUCCESS", "log_url": "..."},
    {"job_name": "publish-run-summary", "result": "SUCCESS", "log_url": "..."}
  ],
  "artifacts": [...]
}
```

Fetch the run summary once `publish-run-summary` is `SUCCESS`:

```bash
curl -s http://localhost:4100/runs/01ARZ3NDEKTSV4RRFFQ69G5FAV/summary | python3 -m json.tool
```

**Zero-cost dry run:** add `"mock": true` to the POST body. The exact same
job graph runs, but every agent role invokes `agent-runtime --mock`
(a recorded fixture, no real model call) — useful for verifying the
plumbing without spending tokens.

**Set a specific model:** add `"model": "opencode/big-pickle"` (or any
other configured model) to the POST body — this overrides the job-level
default for that one run.

## 4. `make demo` — one command, a full transcript

```bash
make demo
```

Runs a fresh happy-path request through the real Run API and prints (and
saves, under `zuul/.demo-transcripts/`, gitignored) a timestamped
transcript: the `POST /runs` response, live polling progress, the final
`run-summary.json`, and the rendered `run-summary.md`.

## 5. Reading a `run-summary.md`

Every run publishes both a machine (`run-summary.json`) and human
(`run-summary.md`) rendering. The Markdown file has four sections:

- **Final verdict** — `success`/`failure`/`error`, derived **solely** from
  `tool-validation`'s deterministic checks. The reviewer's opinion is
  advisory only and never affects this field.
- **Results** — one row per role (planner/coder/validation/reviewer) with
  its status, a one-line summary, and a link to its full artifact.
- **Telemetry totals** — summed `tokens_input`/`tokens_output`/`cost`
  across every role that invoked a real model (zero for a `"mock": true`
  run).
- **Artifacts** / **Build URLs** / **Prompt files used** — every published
  artifact URL, the Zuul buildset detail page, and which `prompts/*.md`
  file each role used.

## 6. Running the hardening scenarios (Phase 6)

Six Live E2E scenarios prove specific failure modes are bounded and
explicit (docs/PLAN.md §11 Phase 6). **All six cost real model tokens**
(none use `"mock": true` — that would defeat their purpose).

```bash
make e2e-6-1   # happy path: all jobs SUCCESS
make e2e-6-2   # malformed agent output: planner exits 30, downstream skipped, raw output still published
make e2e-6-3   # invalid model name: bounded retries, exits 20 (not a hang)
make e2e-6-4   # task targets a nonexistent file: tool-validation fails at patch-applies/patch-non-empty
make e2e-6-5   # task breaks the test suite: tool-validation fails specifically at check 8 (test)
make e2e-6-6   # workspace-escape attempt: repo provably unmodified on disk regardless of which layer catches it

make e2e-6     # all six, in sequence (they share the semaphore-limited executor), full pass/fail summary
```

Each scenario script is individually re-runnable
(`zuul/scripts/e2e-6-*.sh`) and permits at most **one** bounded retry, and
only for the well-documented, unrelated real-model non-determinism
described in `docs/PLAN.md`'s Phase 3/4/5 notes — never to retry away the
scenario's own intended failure.

**All Live E2E gates in sequence** (every phase's gate, costs real model
tokens for `e2e-2` through `e2e-6`):

```bash
make e2e
```

## 7. Troubleshooting quick-reference

| Symptom | Fix |
|---|---|
| A build shows `RETRY`/`RETRY_LIMIT` with empty console output | `docker compose -p zuul-poc -f zuul/docker-compose.yaml restart executor` (a stale/wedged executor — see `zuul/README.md`) |
| A job hangs far longer than usual (many minutes) for a trivial task | Check `docker compose ... logs executor` for silence; this can be genuine model-backend latency, not a code bug — give it time before assuming something is broken |
| `make phase1-e2e-1`/similar suddenly fails with "dubious ownership" | A `zuul-config`/`playbook` git edit needs `make phase1-reload` (push + `zuul-scheduler full-reconfigure`), not just a scheduler restart |
| A `POST /runs` never reaches a terminal state and no new job ever starts | Check `curl http://localhost:9000/api/tenant/agents/semaphores` — if `agent-model-concurrency` shows `count: 2` with no active builds, the holders are stale (from a killed/wedged job); `zuul-client dequeue --tenant agents --pipeline agent-run --project agent-runs --ref refs/heads/agent-runs` (repeat until the queue is empty), then restart the executor |
| Port 9000/8000/4100 already in use | Something else is already bound to that port — check `ss -tln`, use `RUN_API_PORT` to move the Run API, or stop the conflicting process before `make phase0-up`/`make phase5-run-api` |

## 8. Shutting down

```bash
make phase5-run-api-stop
make phase0-down         # stop containers, keep volumes (fast restart later)
# or:
make phase0-clean        # stop containers AND remove volumes (full reset)
```
