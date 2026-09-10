#!/usr/bin/env bash
# Gate for Phase 5 (docs/PLAN.md §11 Phase 5, tasks 5.1-5.6) — the headline
# milestone: unlike every prior e2e-N.sh, this one drives the run through
# the real HTTP Run API (`POST /runs`), not a manual git push +
# `zuul-client enqueue-ref`.
#
#   default (Live E2E-5, non-mocked): POST a genuinely trivial task against
#     sandbox/services/example, poll GET /runs/:id until all 6 real jobs
#     (planner-agent, coder-agent, tool-validation, reviewer-agent,
#     publish-run-summary - plus the always-present initialize-agent-run)
#     reach a terminal state, GET /runs/:id/summary, validate it against
#     run-summary.schema.json, fetch every referenced artifact URL and
#     assert HTTP 200 + non-zero length, assert aggregate telemetry > 0,
#     and re-confirm sandbox/services/example is byte-identical on disk
#     (task 4.7's technique, reused).
#
#     Scoping note (task 5.6's own explicit call): this gate asserts on
#     exactly the 6 jobs the plan's Phase 5 gate names PLUS
#     initialize-agent-run (7 total, all in this pipeline) - agent-smoke
#     (the Phase 0 smoke job) also still runs on every push in this
#     pipeline but is NOT asserted on here; it is not part of the Phase 5
#     job graph the plan describes and asserting on it would conflate an
#     unrelated Phase 0 regression check with this milestone gate.
#
#   --mock: POSTs the same request shape plus "mock": true - planner-agent/
#     coder-agent/reviewer-agent then invoke agent-runtime --mock (zero
#     cost); coder-agent's playbook still performs a real, deterministic
#     file edit + git diff, so tool-validation and publish-run-summary
#     exercise the identical real path at zero model cost.
#
# Requires: the Run API server reachable at RUN_API_URL (default
# http://localhost:4100) - see `make phase5-run-api`. Requires
# `make build` + `make phase1-reload` first (same precondition as every
# prior phase's live gate).
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "$ROOT_DIR/.." && pwd)"
RUN_API_URL="${RUN_API_URL:-http://localhost:4100}"
SERVICE_DIR="sandbox/services/example"

MODE="live"
if [ "${1:-}" = "--mock" ]; then
  MODE="mock"
fi

BASE_REF="$(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD)"

echo "[$MODE] Waiting for Run API at $RUN_API_URL/healthz..." >&2
for _ in $(seq 1 30); do
  if curl -s -o /dev/null -w '%{http_code}' "$RUN_API_URL/healthz" | grep -q '^200$'; then
    break
  fi
  sleep 1
done
if ! curl -s -o /dev/null -w '%{http_code}' "$RUN_API_URL/healthz" | grep -q '^200$'; then
  echo "[$MODE] FAILED: Run API not reachable at $RUN_API_URL - run 'make phase5-run-api' first" >&2
  exit 1
fi

# Task 4.7's technique, reused: checksum sandbox/services/example BEFORE
# the run, re-checked after the full chain reaches a terminal state.
checksum_sandbox() {
  find "$REPO_ROOT/$SERVICE_DIR" -type f -not -path '*/node_modules/*' -print0 |
    sort -z |
    xargs -0 sha256sum |
    sha256sum |
    awk '{print $1}'
}
CHECKSUM_BEFORE="$(checksum_sandbox)"

MOCK_FIELD="false"
[ "$MODE" = "mock" ] && MOCK_FIELD="true"

# Cost discipline (plan §10): a genuinely trivial but real task.
REQUEST_BODY=$(MOCK_FIELD="$MOCK_FIELD" BASE_REF="$BASE_REF" SERVICE_DIR="$SERVICE_DIR" python3 -c "
import json, os
print(json.dumps({
    'task': 'Add a one-line comment above the add function in index.js explaining what it does.',
    'repo': os.environ['SERVICE_DIR'],
    'base_ref': os.environ['BASE_REF'],
    'mock': os.environ['MOCK_FIELD'] == 'true',
}))
")

echo "[$MODE] POST /runs..." >&2
RESPONSE=$(curl -s -w '\n%{http_code}' -X POST "$RUN_API_URL/runs" -H 'Content-Type: application/json' -d "$REQUEST_BODY")
HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
BODY=$(echo "$RESPONSE" | sed '$d')

if [ "$HTTP_CODE" != "202" ]; then
  echo "[$MODE] FAILED: POST /runs returned HTTP $HTTP_CODE: $BODY" >&2
  exit 1
fi

RUN_ID=$(echo "$BODY" | python3 -c "import sys,json; print(json.load(sys.stdin)['run_id'])")
echo "$RUN_ID" | grep -qE '^[0-9A-HJKMNP-TV-Z]{26}$' || {
  echo "[$MODE] FAILED: run_id '$RUN_ID' is not ULID-shaped" >&2
  exit 1
}
echo "[$MODE] PASSED: HTTP 202, run_id=$RUN_ID is ULID-shaped." >&2

echo "[$MODE] Polling GET /runs/$RUN_ID until terminal..." >&2
STATUS=""
for _ in $(seq 1 240); do
  STATUS_JSON=$(curl -s "$RUN_API_URL/runs/$RUN_ID")
  STATUS=$(echo "$STATUS_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin).get('status') or 'PENDING')")
  if [ "$STATUS" != "PENDING" ] && [ -n "$STATUS" ]; then
    break
  fi
  sleep 2
done

if [ "$STATUS" = "PENDING" ] || [ -z "$STATUS" ]; then
  echo "[$MODE] FAILED: timed out waiting for a terminal buildset status" >&2
  exit 1
fi
echo "[$MODE] Buildset terminal status: $STATUS" >&2
echo "$STATUS_JSON" | python3 -c "
import sys, json
d = json.load(sys.stdin)
for b in d.get('builds', []):
    print(f\"  {b['job_name']}: {b['result']} (log_url={b.get('log_url')})\", file=sys.stderr)
"

EXPECTED_JOBS="initialize-agent-run planner-agent coder-agent tool-validation reviewer-agent publish-run-summary"
for job in $EXPECTED_JOBS; do
  RESULT=$(echo "$STATUS_JSON" | python3 -c "
import sys, json
d = json.load(sys.stdin)
for b in d.get('builds', []):
    if b['job_name'] == '$job':
        print(b['result'])
        break
else:
    print('ABSENT')
")
  if [ "$RESULT" = "ABSENT" ]; then
    echo "[$MODE] FAILED: job '$job' never appeared in the buildset" >&2
    exit 1
  fi
  if [ "$RESULT" != "SUCCESS" ]; then
    echo "[$MODE] FAILED: job '$job' result=$RESULT (expected SUCCESS)" >&2
    exit 1
  fi
  echo "[$MODE] $job: $RESULT" >&2
done
echo "[$MODE] PASSED: all 6 expected jobs (+ initializer) reached a terminal state, all SUCCESS." >&2
# Note: reviewer-agent's SUCCESS here reflects the nominal happy-path task
# used by this gate, not a hard requirement of the architecture -
# publish-run-summary's dependency on reviewer-agent is SOFT (projects.yaml)
# specifically so a FAILED or SKIPPED reviewer never blocks the summary
# (plan §11 tasks 5.2/5.3). This gate simply doesn't inject a reviewer
# failure, so SUCCESS is the expected outcome for this particular run.

echo "[$MODE] GET /runs/$RUN_ID/summary..." >&2
SUMMARY_JSON=$(curl -s "$RUN_API_URL/runs/$RUN_ID/summary")

WORKDIR=$(mktemp -d)
trap 'rm -rf "$WORKDIR"' EXIT
echo "$SUMMARY_JSON" > "$WORKDIR/run-summary.json"

node --input-type=module -e "
import { readFileSync } from 'node:fs';
import { validateRunSummary, formatErrors } from '$REPO_ROOT/packages/agent-contracts/dist/index.js';
const data = JSON.parse(readFileSync('$WORKDIR/run-summary.json', 'utf-8'));
const r = validateRunSummary(data);
if (!r.valid) {
  console.error('run-summary.json FAILED schema validation: ' + formatErrors(r.errors));
  process.exit(1);
}
console.log('run-summary.json: schema OK, final_verdict=' + data.final_verdict);
"
echo "[$MODE] PASSED: run-summary.json validates against run-summary.schema.json." >&2

echo "[$MODE] Fetching every artifact_url referenced by the summary..." >&2
python3 -c "
import json
d = json.load(open('$WORKDIR/run-summary.json'))
for u in d.get('artifact_urls', []):
    print(u)
" > "$WORKDIR/artifact-urls.txt"

if [ ! -s "$WORKDIR/artifact-urls.txt" ]; then
  echo "[$MODE] FAILED: run-summary.json's artifact_urls[] is empty" >&2
  exit 1
fi

while IFS= read -r url; do
  CODE=$(curl -s -o "$WORKDIR/fetched-artifact" -w '%{http_code}' "$url")
  SIZE=$(wc -c < "$WORKDIR/fetched-artifact")
  if [ "$CODE" != "200" ] || [ "$SIZE" -eq 0 ]; then
    echo "[$MODE] FAILED: artifact $url returned HTTP $CODE, size=$SIZE" >&2
    exit 1
  fi
  echo "[$MODE]   OK: $url (HTTP $CODE, ${SIZE} bytes)" >&2
done < "$WORKDIR/artifact-urls.txt"
echo "[$MODE] PASSED: every referenced artifact is fetchable with non-zero length." >&2

if [ "$MODE" = "live" ]; then
  echo "[live] Asserting aggregate telemetry is non-zero..." >&2
  python3 -c "
import json
d = json.load(open('$WORKDIR/run-summary.json'))
t = d['totals']
assert t['tokens_input'] > 0, f\"tokens_input={t['tokens_input']} (expected > 0)\"
assert t['tokens_output'] > 0, f\"tokens_output={t['tokens_output']} (expected > 0)\"
print(f\"OK: tokens_input={t['tokens_input']}, tokens_output={t['tokens_output']}, cost={t['cost']}\")
"
fi

# Task 5.5 corollary of task 4.7: re-checksum sandbox/services/example -
# must be byte-identical to before, regardless of MODE.
CHECKSUM_AFTER="$(checksum_sandbox)"
if [ "$CHECKSUM_BEFORE" != "$CHECKSUM_AFTER" ]; then
  echo "[$MODE] FAILED: sandbox/services/example checksum changed! before=$CHECKSUM_BEFORE after=$CHECKSUM_AFTER" >&2
  exit 1
fi
echo "[$MODE] PASSED: sandbox/services/example byte-identical before/after (checksum=$CHECKSUM_BEFORE)." >&2

echo "[$MODE] E2E-5 PASSED: POST /runs -> full buildset -> run-summary.json, all artifacts fetchable, sandbox repo unmodified." >&2
exit 0
