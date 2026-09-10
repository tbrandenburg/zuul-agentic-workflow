#!/usr/bin/env bash
# Gate for Phase 4 (docs/PLAN.md §11 Phase 4, tasks 4.2-4.4, 4.7, 4.8):
#
#   default (Live E2E-4, non-mocked): push a run request against
#   sandbox/services/example with a TRIVIAL but real coding task, enqueue-
#   ref, poll for the full planner -> coder -> tool-validation chain to
#   reach a terminal state, then assert:
#     - coder-agent produced a non-empty patch.diff artifact
#     - tool-validation ran and its report shows all 9 checks, with checks
#       1-8 PASS and check 9 PASS or WARN (never blocking)
#     - the patch applies cleanly at the recorded base_sha (re-verified
#       independently of tool-validation's own check 3, via a throwaway
#       clone on the HOST)
#     - lint and the sandbox test suite passed (per the report)
#     - sandbox/services/example is BYTE-IDENTICAL on disk before and after
#       the run (task 4.7)
#   This costs real model tokens - keep the task trivial (plan §10).
#
#   --mock: pushes the same request shape plus "mock": true. planner-agent/
#   coder-agent then run agent-runtime --mock (zero cost); coder-agent's
#   playbook still performs a REAL, deterministic file edit + git diff
#   (see run-agent.yaml's "(mock only) simulate the coder's file edit"
#   task) so tool-validation exercises the exact same real patch-validation
#   path at zero model cost. A second push with a request.json that always
#   trips the SAME mock edit twice would produce an IDENTICAL patch, which
#   is fine - the point of this mode is exercising the mechanism, not
#   proving model competence.
#
# Honest risk (plan §11 Phase 4, explicit, plan-sanctioned exception): a
# real model may produce a patch that does not apply on a given attempt.
# This script permits exactly ONE retry, and ONLY when tool-validation's
# report shows the FIRST failing check is specifically "patch-applies" -
# any other failure (lint, test, allowlist, ...) is treated as a genuine
# finding and is NOT retried.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "$ROOT_DIR/.." && pwd)"
REPOS_DIR="$ROOT_DIR/gitserver-repos"
ZUUL_URL="${ZUUL_URL:-http://localhost:9000}"
TENANT="${TENANT:-agents}"
PIPELINE="${PIPELINE:-agent-run}"
PROJECT="${PROJECT:-agent-runs}"
SERVICE_DIR="sandbox/services/example"

MODE="live"
if [ "${1:-}" = "--mock" ]; then
  MODE="mock"
fi

if [ ! -d "$REPOS_DIR/agent-runs.git" ]; then
  echo "agent-runs.git not found under $REPOS_DIR; run 'make phase0-seed' first" >&2
  exit 1
fi

BASE_REF="$(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD)"

# Task 4.7: checksum sandbox/services/example BEFORE the run - re-checked
# after, proving the sandbox target repo is never mutated in place (only
# throwaway clones are touched, per plan §6 "Critically" and the Phase 4
# Definition of Done).
checksum_sandbox() {
  find "$REPO_ROOT/$SERVICE_DIR" -type f -not -path '*/node_modules/*' -print0 |
    sort -z |
    xargs -0 sha256sum |
    sha256sum |
    awk '{print $1}'
}
CHECKSUM_BEFORE="$(checksum_sandbox)"

run_once() {
  local run_label="$1"
  local workdir
  workdir=$(mktemp -d)
  trap 'rm -rf "$workdir"' RETURN

  git clone -q "$REPOS_DIR/agent-runs.git" "$workdir/agent-runs" --branch agent-runs
  (
    cd "$workdir/agent-runs"

    OLDREV=$(git rev-parse HEAD)
    RUN_ID=$(python3 -c "
import random
alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
print(''.join(random.choice(alphabet) for _ in range(26)))
")
    mkdir -p "runs/$RUN_ID"

    MOCK_FIELD="false"
    [ "$MODE" = "mock" ] && MOCK_FIELD="true"

    # Cost-discipline (plan §10): trivial but REAL coding task - the model
    # must actually touch a file for tool-validation to have a real
    # patch.diff to validate.
    cat > "runs/$RUN_ID/request.json" <<EOF
{"task": "Add a one-line comment above the add function in index.js explaining what it does.", "repo": "$SERVICE_DIR", "base_ref": "$BASE_REF", "mock": $MOCK_FIELD}
EOF

    git add -A
    git -c user.email=poc@local -c user.name=poc commit -q -m "run: $RUN_ID ($MODE, phase4, $run_label)"
    NEWREV=$(git rev-parse HEAD)
    git push -q origin agent-runs

    echo "[$MODE/$run_label] Pushed $OLDREV..$NEWREV for run $RUN_ID" >&2

    TOKEN=$(docker compose -p zuul-poc -f "$ROOT_DIR/docker-compose.yaml" \
      exec -T scheduler zuul-admin create-auth-token \
        --auth-config zuul_operator --user run-api --tenant "$TENANT" \
        --expires-in 300 2>/dev/null | sed 's/^Bearer //' | tr -d '\r\n')

    zuul-client --zuul-url "$ZUUL_URL" --auth-token "$TOKEN" enqueue-ref \
      --tenant "$TENANT" --pipeline "$PIPELINE" --project "$PROJECT" \
      --ref refs/heads/agent-runs --oldrev "$OLDREV" --newrev "$NEWREV"

    echo "$NEWREV" > "$workdir/newrev"
  )
  cat "$workdir/newrev"
}

wait_for_buildset() {
  local newrev="$1"
  for _ in $(seq 1 240); do
    RESPONSE=$(curl -s "$ZUUL_URL/api/tenant/$TENANT/buildsets?newrev=$newrev")
    RESULT=$(echo "$RESPONSE" | python3 -c "
import sys, json
d = json.load(sys.stdin)
print(d[0]['result'] if d and d[0].get('result') else 'PENDING')
")
    if [ "$RESULT" != "PENDING" ] && [ -n "$RESULT" ]; then
      echo "$RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin)[0]['uuid'])"
      return 0
    fi
    sleep 2
  done
  return 1
}

result_for() {
  local builds_json="$1" job_name="$2"
  echo "$builds_json" | python3 -c "
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

log_url_for() {
  local builds_json="$1" job_name="$2"
  echo "$builds_json" | python3 -c "
import sys, json
d = json.load(sys.stdin)
for b in d['builds']:
    if b['job_name'] == '$job_name':
        print(b.get('log_url') or '')
        break
"
}

attempt() {
  local attempt_no="$1"
  local newrev buildset_uuid builds_json

  newrev=$(run_once "attempt-$attempt_no")
  echo "[$MODE] attempt $attempt_no: enqueued newrev=$newrev, waiting for buildset..." >&2

  buildset_uuid=$(wait_for_buildset "$newrev") || {
    echo "[$MODE] attempt $attempt_no: timed out waiting for buildset result" >&2
    return 2
  }
  builds_json=$(curl -s "$ZUUL_URL/api/tenant/$TENANT/buildset/$buildset_uuid")
  echo "$builds_json" | python3 -c "
import sys, json
d = json.load(sys.stdin)
for b in d['builds']:
    print(f\"  {b['job_name']}: {b['result']} (log_url={b.get('log_url')})\", file=sys.stderr)
"

  local coder_result validation_result coder_log_url validation_log_url
  coder_result=$(result_for "$builds_json" "coder-agent")
  validation_result=$(result_for "$builds_json" "tool-validation")
  coder_log_url=$(log_url_for "$builds_json" "coder-agent")
  validation_log_url=$(log_url_for "$builds_json" "tool-validation")

  if [ "$coder_result" != "SUCCESS" ]; then
    echo "[$MODE] attempt $attempt_no: coder-agent result=$coder_result (expected SUCCESS) - not a retryable condition" >&2
    return 3
  fi

  local scratch
  scratch=$(mktemp -d)
  curl -s -o "$scratch/patch.diff" "${coder_log_url%/}/artifacts/coder/patch.diff"
  curl -s -o "$scratch/validation-report.json" "${validation_log_url%/}/artifacts/validation/validation-report.json"

  if [ ! -s "$scratch/patch.diff" ]; then
    echo "[$MODE] attempt $attempt_no: coder-agent produced an EMPTY patch.diff artifact" >&2
    rm -rf "$scratch"
    return 3
  fi
  echo "[$MODE] attempt $attempt_no: coder-agent produced a non-empty patch.diff ($(wc -l < "$scratch/patch.diff") lines)" >&2

  if [ "$validation_result" != "SUCCESS" ]; then
    # Determine whether the FIRST failing check is specifically
    # "patch-applies" - the one plan-sanctioned retryable condition.
    local first_fail_check
    first_fail_check=$(python3 -c "
import json
d = json.load(open('$scratch/validation-report.json'))
for c in d['checks']:
    if c['status'] == 'FAIL':
        print(c['name'])
        break
")
    echo "[$MODE] attempt $attempt_no: tool-validation FAILED, first failing check='$first_fail_check'" >&2
    rm -rf "$scratch"
    if [ "$first_fail_check" = "patch-applies" ]; then
      return 1 # retryable
    fi
    return 3 # genuine finding, not retryable
  fi

  echo "[$MODE] attempt $attempt_no: tool-validation SUCCESS - independently verifying the report..." >&2
  python3 -c "
import json
d = json.load(open('$scratch/validation-report.json'))
assert d['passed'] is True, 'report.passed is not True'
by_name = {c['name']: c for c in d['checks']}
for name in ['schema','patch-non-empty','patch-applies','allowlist','forbidden-paths','secret-scan','lint','test']:
    status = by_name[name]['status']
    assert status == 'PASS', f'{name}: expected PASS, got {status}'
claims_status = by_name['claims-cross-check']['status']
assert claims_status in ('PASS', 'WARN'), f'claims-cross-check: expected PASS or WARN, got {claims_status}'
print('OK: checks 1-8 PASS, claims-cross-check=' + claims_status)
"

  echo "[$MODE] attempt $attempt_no: independently re-verifying git apply --check at the recorded base_sha (host-side, separate from tool-validation's own check)..." >&2
  local verify_clone
  verify_clone=$(mktemp -d)
  BASE_SHA=$(git -C "$REPO_ROOT" rev-parse "$BASE_REF")
  git clone -q --no-hardlinks "$REPO_ROOT" "$verify_clone"
  git -C "$verify_clone" checkout -q "$BASE_SHA"
  git -C "$verify_clone" apply --check "$scratch/patch.diff"
  echo "[$MODE] attempt $attempt_no: host-side git apply --check OK against base_sha=$BASE_SHA" >&2
  rm -rf "$verify_clone" "$scratch"
  return 0
}

STATUS=1
for attempt_no in 1 2; do
  set +e
  attempt "$attempt_no"
  STATUS=$?
  set -e
  if [ "$STATUS" -eq 0 ]; then
    break
  fi
  if [ "$STATUS" -ne 1 ]; then
    break
  fi
  echo "[$MODE] retrying once (plan-sanctioned exception for a non-applying patch)..." >&2
done

# Task 4.7: re-checksum sandbox/services/example AFTER the full run - must
# be byte-identical to before, regardless of attempt outcome.
CHECKSUM_AFTER="$(checksum_sandbox)"
if [ "$CHECKSUM_BEFORE" != "$CHECKSUM_AFTER" ]; then
  echo "[$MODE] FAILED (task 4.7): sandbox/services/example checksum changed! before=$CHECKSUM_BEFORE after=$CHECKSUM_AFTER" >&2
  exit 1
fi
echo "[$MODE] task 4.7 OK: sandbox/services/example byte-identical before/after (checksum=$CHECKSUM_BEFORE)" >&2

if [ "$STATUS" -ne 0 ]; then
  echo "[$MODE] FAILED after retries (status=$STATUS)" >&2
  exit 1
fi

echo "[$MODE] PASSED: patch.diff produced, tool-validation's 9 checks all PASS (claims WARN-tolerant), patch independently re-verified, sandbox repo unmodified." >&2
exit 0
