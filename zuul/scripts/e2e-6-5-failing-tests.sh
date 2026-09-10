#!/usr/bin/env bash
# Phase 6, scenario 6.5 (docs/PLAN.md §11 Phase 6) — Failing tests.
#
# Injection: a task description asking for a change that breaks
# sandbox/services/example's existing test suite.
#
# Required outcome: tool-validation fails SPECIFICALLY at check 8 ("test") -
# checks 1-7 (schema/patch-non-empty/patch-applies/allowlist/
# forbidden-paths/secret-scan/lint) must all PASS, proving the patch is
# syntactically/structurally fine and only the actual test assertions fail.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
source ./e2e-6-lib.sh

log "[6.5] Waiting for Run API..."
e6_wait_for_run_api || exit 1

CHECKSUM_BEFORE="$(e6_checksum_repo_hash)"

log "[6.5] POST /runs (task breaks the existing test suite)..."
RUN_ID=$(e6_post_run "Change add() in lib/math.js to always return 0, regardless of input.") || exit 1
log "[6.5] run_id=$RUN_ID"

STATUS_JSON=$(e6_poll_terminal "$RUN_ID") || exit 1
e6_print_jobs "$STATUS_JSON"

for job in planner-agent coder-agent; do
  RESULT=$(e6_job_result "$STATUS_JSON" "$job")
  if [ "$RESULT" != "SUCCESS" ]; then
    log "[6.5] FAILED: job '$job' result=$RESULT (expected SUCCESS - the intended fault is at tool-validation check 8)"
    exit 1
  fi
  log "[6.5] $job: SUCCESS"
done

VALIDATION_RESULT=$(e6_job_result "$STATUS_JSON" tool-validation)
if [ "$VALIDATION_RESULT" != "FAILURE" ]; then
  log "[6.5] FAILED: tool-validation result=$VALIDATION_RESULT (expected FAILURE)"
  exit 1
fi
log "[6.5] tool-validation: FAILURE (as required)"

LOG_URL=$(e6_job_log_url "$STATUS_JSON" tool-validation)
REPORT_URL="${LOG_URL%/}/artifacts/validation/validation-report.json"
REPORT_JSON=$(curl -s "$REPORT_URL")
if [ -z "$REPORT_JSON" ]; then
  log "[6.5] FAILED: could not fetch validation-report.json at $REPORT_URL"
  exit 1
fi

echo "$REPORT_JSON" | python3 -c "
import sys, json
d = json.load(sys.stdin)
checks = {c['name']: c['status'] for c in d.get('checks', [])}
print(json.dumps(checks, indent=2))
" >&2

RESULT=$(echo "$REPORT_JSON" | python3 -c "
import sys, json
d = json.load(sys.stdin)
checks = {c['name']: c['status'] for c in d.get('checks', [])}
expected_pass = ['schema', 'patch-non-empty', 'patch-applies', 'allowlist', 'forbidden-paths', 'secret-scan', 'lint']
bad = [n for n in expected_pass if checks.get(n) != 'PASS']
if bad:
    print('BAD_PASS_CHECKS:' + ','.join(bad))
elif checks.get('test') != 'FAIL':
    print('TEST_NOT_FAIL:' + str(checks.get('test')))
else:
    print('OK')
")

if [ "$RESULT" != "OK" ]; then
  log "[6.5] FAILED: $RESULT"
  exit 1
fi
log "[6.5] PASSED: checks 1-7 all PASS, check 8 (test) FAILS - exactly as documented for this scenario."

CHECKSUM_AFTER="$(e6_checksum_repo_hash)"
if [ "$CHECKSUM_BEFORE" != "$CHECKSUM_AFTER" ]; then
  log "[6.5] FAILED: repo checksum changed! before=$CHECKSUM_BEFORE after=$CHECKSUM_AFTER"
  exit 1
fi

log "[6.5] PASSED: failing-tests scenario fully verified, repo unmodified."
exit 0
