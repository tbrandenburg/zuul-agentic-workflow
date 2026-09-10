#!/usr/bin/env bash
# Phase 6, scenario 6.1 (docs/PLAN.md §11 Phase 6) — Happy path.
#
# No injection. A trivial-but-real task against sandbox/services/example
# (same cost-discipline pattern as e2e-5.sh). Required outcome: all 7 jobs
# (initialize-agent-run + the 6 named in the plan's table) SUCCESS, a
# complete artifact bundle, and run-summary.json's final_verdict ==
# "success".
#
# Live E2E — real Zuul, real containers, real model. Requires `make build`,
# `make phase1-reload`, and `make phase5-run-api` first.
#
# Permits exactly ONE retry, ONLY if the failure is planner-agent's own
# well-documented real-model non-determinism (exit 30, "no fenced json
# block found" - see docs/PLAN.md Phases 3/4/5 notes) - the same
# plan-sanctioned exception already used by e2e-3/e2e-4/e2e-5. Any other
# failure mode is NOT retried.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
source ./e2e-6-lib.sh

log "[6.1] Waiting for Run API..."
e6_wait_for_run_api || exit 1

run_once() {
  CHECKSUM_BEFORE="$(e6_checksum_repo_hash)"

  log "[6.1] POST /runs (happy path)..."
  RUN_ID=$(e6_post_run "Add a one-line comment above the add function in index.js explaining what it does.") || return 1
  log "[6.1] run_id=$RUN_ID"

  STATUS_JSON=$(e6_poll_terminal "$RUN_ID") || return 1
  e6_print_jobs "$STATUS_JSON"

  PLANNER_RESULT=$(e6_job_result "$STATUS_JSON" planner-agent)
  if [ "$PLANNER_RESULT" = "FAILURE" ]; then
    LOG_URL=$(e6_job_log_url "$STATUS_JSON" planner-agent)
    if curl -s "${LOG_URL%/}/job-output.json" | grep -q "exit 30"; then
      log "[6.1] planner-agent FAILED with the documented real-model exit-30 non-determinism - retryable."
      return 2
    fi
  fi

  EXPECTED_JOBS="initialize-agent-run planner-agent coder-agent tool-validation reviewer-agent publish-run-summary"
  FAIL=0
  for job in $EXPECTED_JOBS; do
    RESULT=$(e6_job_result "$STATUS_JSON" "$job")
    if [ "$RESULT" != "SUCCESS" ]; then
      log "[6.1] FAILED: job '$job' result=$RESULT (expected SUCCESS)"
      FAIL=1
    else
      log "[6.1] $job: SUCCESS"
    fi
  done
  [ "$FAIL" -eq 0 ] || return 1

  log "[6.1] GET /runs/$RUN_ID/summary..."
  SUMMARY_JSON=$(curl -s "$RUN_API_URL/runs/$RUN_ID/summary")
  WORKDIR=$(mktemp -d)
  echo "$SUMMARY_JSON" > "$WORKDIR/run-summary.json"

  node --input-type=module -e "
import { readFileSync } from 'node:fs';
import { validateRunSummary, formatErrors } from '$REPO_ROOT/packages/agent-contracts/dist/index.js';
const data = JSON.parse(readFileSync('$WORKDIR/run-summary.json', 'utf-8'));
const r = validateRunSummary(data);
if (!r.valid) { console.error('schema FAILED: ' + formatErrors(r.errors)); process.exit(1); }
if (data.final_verdict !== 'success') { console.error('FAILED: final_verdict=' + data.final_verdict + ' (expected success)'); process.exit(1); }
console.log('run-summary.json: schema OK, final_verdict=success');
" || { rm -rf "$WORKDIR"; return 1; }

  log "[6.1] Fetching every artifact_url referenced by the summary..."
  python3 -c "
import json
d = json.load(open('$WORKDIR/run-summary.json'))
for u in d.get('artifact_urls', []):
    print(u)
" > "$WORKDIR/artifact-urls.txt"

  if [ ! -s "$WORKDIR/artifact-urls.txt" ]; then
    log "[6.1] FAILED: run-summary.json's artifact_urls[] is empty"
    rm -rf "$WORKDIR"
    return 1
  fi
  while IFS= read -r url; do
    CODE=$(curl -s -o "$WORKDIR/fetched" -w '%{http_code}' "$url")
    SIZE=$(wc -c < "$WORKDIR/fetched")
    if [ "$CODE" != "200" ] || [ "$SIZE" -eq 0 ]; then
      log "[6.1] FAILED: artifact $url returned HTTP $CODE, size=$SIZE"
      rm -rf "$WORKDIR"
      return 1
    fi
    log "[6.1]   OK: $url (HTTP $CODE, ${SIZE} bytes)"
  done < "$WORKDIR/artifact-urls.txt"
  rm -rf "$WORKDIR"

  CHECKSUM_AFTER="$(e6_checksum_repo_hash)"
  if [ "$CHECKSUM_BEFORE" != "$CHECKSUM_AFTER" ]; then
    log "[6.1] FAILED: repo checksum changed! before=$CHECKSUM_BEFORE after=$CHECKSUM_AFTER"
    return 1
  fi

  log "[6.1] PASSED: happy path - all jobs SUCCESS, complete artifact bundle, final_verdict=success, repo unmodified."
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
    log "[6.1] FAILED (attempt $ATTEMPT), not a retryable failure mode."
    exit 1
  fi
  log "[6.1] Retrying (attempt $((ATTEMPT + 1)))..."
  ATTEMPT=$((ATTEMPT + 1))
done
log "[6.1] FAILED after 2 attempts."
exit 1
