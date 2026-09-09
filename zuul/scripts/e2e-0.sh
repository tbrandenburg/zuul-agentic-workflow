#!/usr/bin/env bash
# Gate E2E-0 (docs/PLAN.md §11 Phase 0): zuul-client enqueue-ref produces a
# buildset that runs an executor-only job to SUCCESS, verified via the REST
# API. No stubs anywhere: real Zuul, real containers, real enqueue-ref.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPOS_DIR="$ROOT_DIR/gitserver-repos"
ZUUL_URL="${ZUUL_URL:-http://localhost:9000}"
TENANT="${TENANT:-agents}"
PIPELINE="${PIPELINE:-agent-run}"
PROJECT="${PROJECT:-agent-runs}"

if [ ! -d "$REPOS_DIR/agent-runs.git" ]; then
  echo "agent-runs.git not found under $REPOS_DIR; run 'make phase0-seed' first" >&2
  exit 1
fi

WORKDIR=$(mktemp -d)
trap 'rm -rf "$WORKDIR"' EXIT

git clone -q "$REPOS_DIR/agent-runs.git" "$WORKDIR/agent-runs" --branch agent-runs
cd "$WORKDIR/agent-runs"

OLDREV=$(git rev-parse HEAD)
RUN_ID="e2e0-$(date +%s)"
mkdir -p "runs/$RUN_ID"
echo "{\"run_id\":\"$RUN_ID\",\"task\":\"E2E-0 smoke test\"}" > "runs/$RUN_ID/request.json"
git add -A
git -c user.email=poc@local -c user.name=poc commit -q -m "run: $RUN_ID"
NEWREV=$(git rev-parse HEAD)
git push -q origin agent-runs

echo "Pushed $OLDREV..$NEWREV for run $RUN_ID" >&2

TOKEN=$(docker compose -p zuul-poc -f "$ROOT_DIR/docker-compose.yaml" \
  exec -T scheduler zuul-admin create-auth-token \
    --auth-config zuul_operator --user run-api --tenant "$TENANT" \
    --expires-in 300 2>/dev/null | sed 's/^Bearer //' | tr -d '\r\n')

zuul-client --zuul-url "$ZUUL_URL" --auth-token "$TOKEN" enqueue-ref \
  --tenant "$TENANT" --pipeline "$PIPELINE" --project "$PROJECT" \
  --ref refs/heads/agent-runs --oldrev "$OLDREV" --newrev "$NEWREV"

echo "Enqueued. Waiting for buildset result..." >&2

for i in $(seq 1 60); do
  RESULT=$(curl -s "$ZUUL_URL/api/tenant/$TENANT/buildsets?newrev=$NEWREV" \
    | python3 -c "
import sys, json
d = json.load(sys.stdin)
r = d[0]['result'] if d else None
print(r if r else 'PENDING')
")
  if [ "$RESULT" != "PENDING" ] && [ -n "$RESULT" ]; then
    echo "Buildset result: $RESULT"
    if [ "$RESULT" = "SUCCESS" ]; then
      exit 0
    else
      exit 1
    fi
  fi
  sleep 2
done

echo "Timed out waiting for buildset result for newrev=$NEWREV" >&2
exit 1
