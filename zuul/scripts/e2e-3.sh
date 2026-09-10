#!/usr/bin/env bash
# Gate for Phase 3 (docs/PLAN.md §11 Phase 3, tasks 3.1-3.6):
#
#   default (Live E2E-3, non-mocked): push a valid runs/<id>/request.json
#     with a TRIVIAL task description, enqueue-ref, poll for buildset
#     SUCCESS, then assert:
#       - planner-agent AND coder-agent builds both reached SUCCESS
#       - both agent-result.json artifacts are schema-valid
#       - both carry non-zero telemetry (tokens_input>0, duration_ms>0)
#       - coder-agent's captured agent-input.json artifact has
#         upstream_results[0].summary BYTE-IDENTICAL to the planner's
#         returned summary
#     This costs real model tokens for both roles - keep the task trivial.
#
#   --mock: pushes the SAME request.json shape plus `"mock": true`, which
#     init-run.yaml passes through to agent_result_initialize.mock and
#     jobs.yaml's agent_mock var - the SAME planner-agent/coder-agent jobs
#     then invoke `agent-runtime --mock` (see run-agent.yaml). Genuinely
#     zero model cost: no separate "-mock" job variants exist (an earlier
#     design had them, but since Zuul has no per-push conditional job
#     selection in a single project stanza, they ran ALONGSIDE the real
#     jobs on every push and never actually avoided cost - see docs/PLAN.md
#     Phase 3 notes for the full story). No telemetry assertion in this mode
#     since agent-runtime --mock invokes no model.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPOS_DIR="$ROOT_DIR/gitserver-repos"
ZUUL_URL="${ZUUL_URL:-http://localhost:9000}"
TENANT="${TENANT:-agents}"
PIPELINE="${PIPELINE:-agent-run}"
PROJECT="${PROJECT:-agent-runs}"

MODE="live"
if [ "${1:-}" = "--mock" ]; then
  MODE="mock"
fi

if [ ! -d "$REPOS_DIR/agent-runs.git" ]; then
  echo "agent-runs.git not found under $REPOS_DIR; run 'make phase0-seed' first" >&2
  exit 1
fi

WORKDIR=$(mktemp -d)
trap 'rm -rf "$WORKDIR"' EXIT

git clone -q "$REPOS_DIR/agent-runs.git" "$WORKDIR/agent-runs" --branch agent-runs
cd "$WORKDIR/agent-runs"

OLDREV=$(git rev-parse HEAD)

# run_id must match agent-input.schema.json's ULID-shaped pattern
# (^[0-9A-HJKMNP-TV-Z]{26}$, Crockford base32, uppercase, no I/L/O/U) since
# it flows run-request.json -> agent_result_initialize.run_id ->
# agent-input.json in this phase (unlike Phase 1's e2e-1.sh, whose run_id
# never reached a schema-validated manifest).
RUN_ID=$(python3 -c "
import random
alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
print(''.join(random.choice(alphabet) for _ in range(26)))
")
mkdir -p "runs/$RUN_ID"

MOCK_FIELD="false"
if [ "$MODE" = "mock" ]; then
  MOCK_FIELD="true"
fi

# Cost-discipline (plan §10): trivial task description - in --mock mode it's
# never sent to a model at all; in live mode it costs real tokens for both
# planner and coder roles, so it stays trivial regardless.
cat > "runs/$RUN_ID/request.json" <<EOF
{"task": "Say hello in one sentence.", "repo": "sandbox/services/example", "base_ref": "main", "mock": $MOCK_FIELD}
EOF

git add -A
git -c user.email=poc@local -c user.name=poc commit -q -m "run: $RUN_ID ($MODE, phase3)"
NEWREV=$(git rev-parse HEAD)
git push -q origin agent-runs

echo "[$MODE] Pushed $OLDREV..$NEWREV for run $RUN_ID" >&2

TOKEN=$(docker compose -p zuul-poc -f "$ROOT_DIR/docker-compose.yaml" \
  exec -T scheduler zuul-admin create-auth-token \
    --auth-config zuul_operator --user run-api --tenant "$TENANT" \
    --expires-in 300 2>/dev/null | sed 's/^Bearer //' | tr -d '\r\n')

zuul-client --zuul-url "$ZUUL_URL" --auth-token "$TOKEN" enqueue-ref \
  --tenant "$TENANT" --pipeline "$PIPELINE" --project "$PROJECT" \
  --ref refs/heads/agent-runs --oldrev "$OLDREV" --newrev "$NEWREV"

echo "[$MODE] Enqueued. Waiting for buildset result..." >&2

BUILDSET_UUID=""
RESULT=""
for i in $(seq 1 180); do
  RESPONSE=$(curl -s "$ZUUL_URL/api/tenant/$TENANT/buildsets?newrev=$NEWREV")
  RESULT=$(echo "$RESPONSE" | python3 -c "
import sys, json
d = json.load(sys.stdin)
print(d[0]['result'] if d and d[0].get('result') else 'PENDING')
")
  if [ "$RESULT" != "PENDING" ] && [ -n "$RESULT" ]; then
    BUILDSET_UUID=$(echo "$RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin)[0]['uuid'])")
    break
  fi
  sleep 2
done

if [ -z "$BUILDSET_UUID" ]; then
  echo "[$MODE] Timed out waiting for buildset result for newrev=$NEWREV" >&2
  exit 1
fi

echo "[$MODE] Buildset $BUILDSET_UUID result: $RESULT" >&2

BUILDS_JSON=$(curl -s "$ZUUL_URL/api/tenant/$TENANT/buildset/$BUILDSET_UUID")
echo "$BUILDS_JSON" | python3 -c "
import sys, json
d = json.load(sys.stdin)
for b in d['builds']:
    print(f\"  {b['job_name']}: {b['result']} (log_url={b.get('log_url')})\", file=sys.stderr)
"

log_url_for() {
  local job_name="$1"
  echo "$BUILDS_JSON" | python3 -c "
import sys, json
d = json.load(sys.stdin)
for b in d['builds']:
    if b['job_name'] == '$job_name':
        print(b.get('log_url') or '')
        break
"
}

result_for() {
  local job_name="$1"
  echo "$BUILDS_JSON" | python3 -c "
import sys, json
d = json.load(sys.stdin)
for b in d['builds']:
    if b['job_name'] == '$job_name':
        print(b['result'])
        break
else:
    print('ABSENT')
"
}

PLANNER_RESULT=$(result_for "planner-agent")
CODER_RESULT=$(result_for "coder-agent")

if [ "$PLANNER_RESULT" != "SUCCESS" ]; then
  echo "[$MODE] FAILED: planner-agent result=$PLANNER_RESULT (expected SUCCESS)" >&2
  exit 1
fi
if [ "$CODER_RESULT" != "SUCCESS" ]; then
  echo "[$MODE] FAILED: coder-agent result=$CODER_RESULT (expected SUCCESS)" >&2
  exit 1
fi

PLANNER_LOG_URL=$(log_url_for "planner-agent")
CODER_LOG_URL=$(log_url_for "coder-agent")

curl -s -o "$WORKDIR/planner-result.json" "${PLANNER_LOG_URL%/}/artifacts/planner/agent-result.json"
curl -s -o "$WORKDIR/coder-result.json" "${CODER_LOG_URL%/}/artifacts/coder/agent-result.json"
curl -s -o "$WORKDIR/coder-input.json" "${CODER_LOG_URL%/}/artifacts/coder/agent-input.json"

echo "[$MODE] Independently validating both agent-result.json files against agent-result.schema.json..." >&2
node --input-type=module -e "
import { readFileSync } from 'node:fs';
import { validateAgentResult, formatErrors } from '$ROOT_DIR/../packages/agent-contracts/dist/index.js';
for (const f of ['$WORKDIR/planner-result.json', '$WORKDIR/coder-result.json']) {
  const data = JSON.parse(readFileSync(f, 'utf-8'));
  const r = validateAgentResult(data);
  if (!r.valid) {
    console.error(f + ' FAILED schema validation: ' + formatErrors(r.errors));
    process.exit(1);
  }
  console.log(f + ': schema OK, status=' + data.status);
}
"

if [ "$MODE" = "live" ]; then
  echo "[live] Checking non-zero telemetry on both results..." >&2
  python3 -c "
import json
for f in ['$WORKDIR/planner-result.json', '$WORKDIR/coder-result.json']:
    d = json.load(open(f))
    t = d.get('telemetry') or {}
    tokens_input = t.get('tokens_input', 0)
    duration_ms = t.get('duration_ms', 0)
    assert tokens_input > 0, f'{f}: tokens_input={tokens_input} (expected > 0)'
    assert duration_ms > 0, f'{f}: duration_ms={duration_ms} (expected > 0)'
    print(f'{f}: tokens_input={tokens_input}, duration_ms={duration_ms}')
"
fi

echo "[$MODE] Checking coder's captured agent-input.json contains the planner's byte-identical summary..." >&2
python3 -c "
import json
planner = json.load(open('$WORKDIR/planner-result.json'))
coder_input = json.load(open('$WORKDIR/coder-input.json'))
upstream = coder_input.get('upstream_results') or []
assert len(upstream) == 1, f'expected exactly 1 upstream_results entry, got {len(upstream)}'
entry = upstream[0]
assert entry['role'] == 'planner', f\"expected upstream role 'planner', got {entry['role']!r}\"
assert entry['summary'] == planner['summary'], 'coder upstream_results[0].summary is NOT byte-identical to the planner result summary'
print('OK: upstream_results[0].summary is byte-identical to the planner\'s returned summary')
"

echo "[$MODE] PASSED: planner-agent and coder-agent both SUCCESS, schema-valid, summary propagation proven." >&2
exit 0

