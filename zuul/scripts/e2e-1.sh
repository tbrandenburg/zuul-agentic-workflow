#!/usr/bin/env bash
# Gate for Phase 1 (docs/PLAN.md §11 Phase 1, tasks 1.1-1.4):
#
#   --valid (default): push a valid runs/<id>/request.json, enqueue-ref, poll
#     for buildset SUCCESS, then curl the initializer's published artifact
#     and assert HTTP 200 + non-empty body. Proves the base job's
#     pre/post-logs/cleanup lifecycle and the initializer's artifact
#     publishing work end-to-end (tasks 1.1-1.3).
#
#   --invalid: push a runs/<id>/request.json missing a required field,
#     enqueue-ref, poll for buildset FAILURE, then assert agent-smoke did
#     NOT run (only initialize-agent-run ran) - proving zuul.child_jobs: []
#     pruning actually took effect (task 1.4).
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPOS_DIR="$ROOT_DIR/gitserver-repos"
ZUUL_URL="${ZUUL_URL:-http://localhost:9000}"
TENANT="${TENANT:-agents}"
PIPELINE="${PIPELINE:-agent-run}"
PROJECT="${PROJECT:-agent-runs}"

MODE="valid"
if [ "${1:-}" = "--invalid" ]; then
  MODE="invalid"
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
RUN_ID="e2e1-$(date +%s)"
mkdir -p "runs/$RUN_ID"

if [ "$MODE" = "valid" ]; then
  cat > "runs/$RUN_ID/request.json" <<EOF
{"task": "E2E-1 smoke test", "repo": "sandbox/services/example", "base_ref": "main"}
EOF
else
  # Missing required "base_ref" key - must be pruned by the initializer.
  cat > "runs/$RUN_ID/request.json" <<EOF
{"task": "E2E-1 invalid-request test", "repo": "sandbox/services/example"}
EOF
fi

git add -A
git -c user.email=poc@local -c user.name=poc commit -q -m "run: $RUN_ID ($MODE)"
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
for i in $(seq 1 60); do
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

if [ "$MODE" = "valid" ]; then
  if [ "$RESULT" != "SUCCESS" ]; then
    echo "[valid] FAILED: expected buildset SUCCESS, got $RESULT" >&2
    exit 1
  fi

  INIT_LOG_URL=$(echo "$BUILDS_JSON" | python3 -c "
import sys, json
d = json.load(sys.stdin)
for b in d['builds']:
    if b['job_name'] == 'initialize-agent-run':
        print(b.get('log_url') or '')
        break
")
  if [ -z "$INIT_LOG_URL" ]; then
    echo "[valid] FAILED: initialize-agent-run build has no log_url" >&2
    exit 1
  fi

  ARTIFACT_URL="${INIT_LOG_URL%/}/artifacts/run-request.json"
  echo "[valid] Fetching artifact: $ARTIFACT_URL" >&2
  HTTP_CODE=$(curl -s -o /tmp/e2e1-artifact.json -w '%{http_code}' "$ARTIFACT_URL")
  BODY_SIZE=$(wc -c < /tmp/e2e1-artifact.json)

  if [ "$HTTP_CODE" != "200" ]; then
    echo "[valid] FAILED: artifact URL returned HTTP $HTTP_CODE (expected 200)" >&2
    exit 1
  fi
  if [ "$BODY_SIZE" -eq 0 ]; then
    echo "[valid] FAILED: artifact body is empty" >&2
    exit 1
  fi

  echo "[valid] PASSED: buildset SUCCESS, artifact reachable ($BODY_SIZE bytes) at $ARTIFACT_URL" >&2
  exit 0
else
  AGENT_SMOKE_RESULT=$(echo "$BUILDS_JSON" | python3 -c "
import sys, json
d = json.load(sys.stdin)
for b in d['builds']:
    if b['job_name'] == 'agent-smoke':
        print(b['result'])
        break
else:
    print('ABSENT')
")

  if [ "$AGENT_SMOKE_RESULT" = "SUCCESS" ]; then
    echo "[invalid] FAILED: agent-smoke ran to SUCCESS despite an invalid run request - child_jobs pruning did NOT take effect" >&2
    exit 1
  fi

  if [ "$RESULT" = "SUCCESS" ]; then
    echo "[invalid] FAILED: buildset reported SUCCESS for an invalid run request" >&2
    exit 1
  fi

  echo "[invalid] PASSED: buildset result=$RESULT, agent-smoke result=$AGENT_SMOKE_RESULT (not SUCCESS) - pruning confirmed" >&2
  exit 0
fi
