#!/usr/bin/env bash
# Shared helpers for the six Phase 6 (docs/PLAN.md §11 Phase 6) hardening
# scenarios. Sourced by each zuul/scripts/e2e-6-*.sh script - kept DRY per
# AGENTS.md, but every scenario script stays individually re-runnable
# (source this file, call the helpers, exit 0/1).
#
# ALL SIX scenarios are Live E2E: real Zuul, real containers, real model.
# NONE of them set "mock": true - that would defeat the whole point (see
# the task brief's explicit warning). Only 6.3 injects an invalid --model,
# which is the fault under test, not a mock.
set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "$ROOT_DIR/.." && pwd)"
RUN_API_URL="${RUN_API_URL:-http://localhost:4100}"
SERVICE_DIR="sandbox/services/example"

e6_base_ref() {
  git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD
}

# Checksums the WHOLE repo's tracked+untracked git status (task 6.6's
# "wider scope" requirement) - not just sandbox/services/example, so a
# workspace-escape write anywhere else in the tree is also caught.
e6_checksum_repo() {
  git -C "$REPO_ROOT" status --porcelain=v1 --ignored=no
  find "$REPO_ROOT/$SERVICE_DIR" -type f -not -path '*/node_modules/*' -print0 |
    sort -z |
    xargs -0 sha256sum 2>/dev/null
}
e6_checksum_repo_hash() {
  e6_checksum_repo | sha256sum | awk '{print $1}'
}

e6_wait_for_run_api() {
  for _ in $(seq 1 30); do
    if curl -s -o /dev/null -w '%{http_code}' "$RUN_API_URL/healthz" | grep -q '^200$'; then
      return 0
    fi
    sleep 1
  done
  echo "FAILED: Run API not reachable at $RUN_API_URL - run 'make phase5-run-api' first" >&2
  return 1
}

# e6_post_run <task_json_string> [model]
# Emits the ULID run_id on stdout, or exits 1 on a non-202 response.
e6_post_run() {
  local task="$1"
  local model="${2:-}"
  local base_ref
  base_ref="$(e6_base_ref)"
  local body
  body=$(TASK="$task" REPO="$SERVICE_DIR" BASE_REF="$base_ref" MODEL="$model" python3 -c "
import json, os
req = {
    'task': os.environ['TASK'],
    'repo': os.environ['REPO'],
    'base_ref': os.environ['BASE_REF'],
}
if os.environ.get('MODEL'):
    req['model'] = os.environ['MODEL']
print(json.dumps(req))
")
  local response http_code resp_body
  response=$(curl -s -w '\n%{http_code}' -X POST "$RUN_API_URL/runs" -H 'Content-Type: application/json' -d "$body")
  http_code=$(echo "$response" | tail -n1)
  resp_body=$(echo "$response" | sed '$d')
  if [ "$http_code" != "202" ]; then
    echo "FAILED: POST /runs returned HTTP $http_code: $resp_body" >&2
    return 1
  fi
  local run_id
  run_id=$(echo "$resp_body" | python3 -c "import sys,json; print(json.load(sys.stdin)['run_id'])")
  if ! echo "$run_id" | grep -qE '^[0-9A-HJKMNP-TV-Z]{26}$'; then
    echo "FAILED: run_id '$run_id' is not ULID-shaped" >&2
    return 1
  fi
  echo "$run_id"
}

# e6_poll_terminal <run_id> -> prints the full status JSON to stdout
e6_poll_terminal() {
  local run_id="$1"
  local status_json status
  for _ in $(seq 1 240); do
    status_json=$(curl -s "$RUN_API_URL/runs/$run_id")
    status=$(echo "$status_json" | python3 -c "import sys,json; print(json.load(sys.stdin).get('status') or 'PENDING')")
    if [ "$status" != "PENDING" ] && [ -n "$status" ]; then
      echo "$status_json"
      return 0
    fi
    sleep 2
  done
  echo "FAILED: timed out waiting for a terminal buildset status" >&2
  return 1
}

# e6_job_result <status_json> <job_name> -> prints result or ABSENT
e6_job_result() {
  local status_json="$1" job="$2"
  echo "$status_json" | python3 -c "
import sys, json
d = json.load(sys.stdin)
for b in d.get('builds', []):
    if b['job_name'] == '$job':
        print(b['result'])
        break
else:
    print('ABSENT')
"
}

# e6_job_log_url <status_json> <job_name> -> prints log_url or empty
e6_job_log_url() {
  local status_json="$1" job="$2"
  echo "$status_json" | python3 -c "
import sys, json
d = json.load(sys.stdin)
for b in d.get('builds', []):
    if b['job_name'] == '$job':
        print(b.get('log_url') or '')
        break
else:
    print('')
"
}

e6_print_jobs() {
  local status_json="$1"
  echo "$status_json" | python3 -c "
import sys, json
d = json.load(sys.stdin)
for b in d.get('builds', []):
    print(f\"  {b['job_name']}: {b['result']} (log_url={b.get('log_url')})\", file=sys.stderr)
"
}

# e6_fetch_url <url> -> prints http code, writes body to $1.body via curl
e6_fetch_status() {
  curl -s -o /dev/null -w '%{http_code}' "$1"
}

log() { echo "$@" >&2; }
