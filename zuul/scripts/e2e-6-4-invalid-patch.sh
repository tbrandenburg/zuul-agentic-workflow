#!/usr/bin/env bash
# Phase 6, scenario 6.4 (docs/PLAN.md §11 Phase 6) — Invalid patch (task
# targets a nonexistent file).
#
# Injection: a task description asking the coder to modify a file that does
# not exist at the pinned base_sha.
#
# Required outcome: tool-validation FAILS - asserted at the EXACT check
# name in validation-report.json, not just "some failure" (documented:
# either check 3 "patch-applies" if the model produces some patch, or
# check 2 "patch-non-empty" if the model produces no patch at all - this
# script determines and reports which one actually fired). reviewer-agent
# is SKIPPED (hard dependency on tool-validation's SUCCESS -
# projects.yaml's `coder-agent -> tool-validation -> reviewer-agent` chain
# has no `soft: true`, and Zuul's own semantics skip a child when its hard
# dependency does not SUCCEED - already established by Phase 4's
# phase1-e2e-1-invalid gate pattern, reconfirmed here).
#
# One bounded retry is permitted ONLY when planner-agent/coder-agent fail
# for the well-documented unrelated real-model exit-30 non-determinism
# BEFORE ever reaching tool-validation (this scenario's actual mechanism
# under test) - never to retry away the intended tool-validation FAILURE
# itself.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
source ./e2e-6-lib.sh

log "[6.4] Waiting for Run API..."
e6_wait_for_run_api || exit 1

run_once() {
  CHECKSUM_BEFORE="$(e6_checksum_repo_hash)"

  log "[6.4] POST /runs (task targets a nonexistent file)..."
  RUN_ID=$(e6_post_run "Add a function called ok() to lib/nonexistent-file.js that returns the string 'ok'.") || return 1
  log "[6.4] run_id=$RUN_ID"

  STATUS_JSON=$(e6_poll_terminal "$RUN_ID") || return 1
  e6_print_jobs "$STATUS_JSON"

  for job in planner-agent coder-agent; do
    RESULT=$(e6_job_result "$STATUS_JSON" "$job")
    if [ "$RESULT" != "SUCCESS" ]; then
      log "[6.4] job '$job' result=$RESULT (expected SUCCESS - the intended fault is at tool-validation, not upstream)"
      return 2
    fi
    log "[6.4] $job: SUCCESS"
  done

  VALIDATION_RESULT=$(e6_job_result "$STATUS_JSON" tool-validation)
  if [ "$VALIDATION_RESULT" != "FAILURE" ]; then
    log "[6.4] FAILED: tool-validation result=$VALIDATION_RESULT (expected FAILURE)"
    return 1
  fi
  log "[6.4] tool-validation: FAILURE (as required)"

  REVIEWER_RESULT=$(e6_job_result "$STATUS_JSON" reviewer-agent)
  if [ "$REVIEWER_RESULT" != "SKIPPED" ]; then
    log "[6.4] FAILED: reviewer-agent result=$REVIEWER_RESULT (expected SKIPPED - hard dependency on tool-validation)"
    return 1
  fi
  log "[6.4] reviewer-agent: SKIPPED (as required, confirms Zuul's hard-dependency skip semantics)"

  LOG_URL=$(e6_job_log_url "$STATUS_JSON" tool-validation)
  REPORT_URL="${LOG_URL%/}/artifacts/validation/validation-report.json"
  REPORT_JSON=$(curl -s "$REPORT_URL")
  if [ -z "$REPORT_JSON" ]; then
    log "[6.4] FAILED: could not fetch validation-report.json at $REPORT_URL"
    return 1
  fi

  FIRST_FAIL=$(echo "$REPORT_JSON" | python3 -c "
import sys, json
d = json.load(sys.stdin)
for c in d.get('checks', []):
    if c.get('status') == 'FAIL':
        print(c['name'])
        break
else:
    print('NONE')
")
  log "[6.4] First FAIL check: $FIRST_FAIL"
  if [ "$FIRST_FAIL" != "patch-applies" ] && [ "$FIRST_FAIL" != "patch-non-empty" ]; then
    log "[6.4] FAILED: expected the first FAIL check to be 'patch-applies' or 'patch-non-empty' (documented alternative when the model produces no patch at all), got '$FIRST_FAIL'"
    return 1
  fi
  log "[6.4] PASSED: tool-validation failed at check '$FIRST_FAIL', exactly as documented for this scenario."

  # publish-run-summary's results[] entry for validation should carry the
  # FAIL message. KNOWN GAP (documented in zuul/README.md's Phase 5 notes,
  # reconfirmed empirically this phase): publish-run-summary's dependency
  # on reviewer-agent is SOFT, but that soft link does not survive a skip
  # that originates several levels further upstream (tool-validation
  # FAILURE hard-skips reviewer-agent, and publish-run-summary is then ALSO
  # skipped, not run at all) - "a caller always gets a summary" is
  # therefore not guaranteed by the current wiring for this exact failure
  # shape. projects.yaml is out of this phase's allowed change scope, so
  # this is reported as a finding, not silently worked around. The FAIL
  # reason IS independently verifiable directly from tool-validation's own
  # published validation-report.json (already asserted above via the exact
  # check name) regardless of whether publish-run-summary itself ran.
  SUMMARY_PUBLISH_RESULT=$(e6_job_result "$STATUS_JSON" publish-run-summary)
  if [ "$SUMMARY_PUBLISH_RESULT" = "SUCCESS" ]; then
    SUMMARY_JSON=$(curl -s "$RUN_API_URL/runs/$RUN_ID/summary")
    VALIDATION_SUMMARY=$(echo "$SUMMARY_JSON" | python3 -c "
import sys, json
d = json.load(sys.stdin)
for r in d.get('results', []):
    if r['role'] == 'validation':
        print(r['status'] + '|' + r['summary'])
        break
else:
    print('ABSENT')
")
    log "[6.4] run-summary.json results[validation] = $VALIDATION_SUMMARY"
    V_STATUS="${VALIDATION_SUMMARY%%|*}"
    V_TEXT="${VALIDATION_SUMMARY#*|}"
    if [ "$V_STATUS" = "failure" ] && echo "$V_TEXT" | grep -qi "FAILED"; then
      log "[6.4] PASSED: run-summary.json states the validation FAILURE reason."
    else
      log "[6.4] FAILED: run-summary.json's validation entry does not clearly state a FAILURE reason: $VALIDATION_SUMMARY"
      return 1
    fi
  else
    log "[6.4] FINDING: publish-run-summary result=$SUMMARY_PUBLISH_RESULT (not SUCCESS) - known Phase 5 gap (soft dep on reviewer-agent does not survive tool-validation's hard-dep-chain skip). The FAIL reason is independently confirmed above via validation-report.json regardless."
  fi

  CHECKSUM_AFTER="$(e6_checksum_repo_hash)"
  if [ "$CHECKSUM_BEFORE" != "$CHECKSUM_AFTER" ]; then
    log "[6.4] FAILED: repo checksum changed! before=$CHECKSUM_BEFORE after=$CHECKSUM_AFTER"
    return 1
  fi

  log "[6.4] PASSED: invalid-patch scenario fully verified, repo unmodified."
  return 0
}

ATTEMPT=1
while [ "$ATTEMPT" -le 2 ]; do
  run_once
  RC=$?
  if [ "$RC" -eq 0 ]; then
    exit 0
  fi
  if [ "$RC" -eq 1 ]; then
    log "[6.4] FAILED (attempt $ATTEMPT), not a retryable failure mode."
    exit 1
  fi
  log "[6.4] Wrong-point failure (upstream, unrelated to the mechanism under test) on attempt $ATTEMPT, retrying once..."
  ATTEMPT=$((ATTEMPT + 1))
done
log "[6.4] FAILED after 2 attempts."
exit 1
