#!/usr/bin/env bash
# Phase 6, scenario 6.3 (docs/PLAN.md §11 Phase 6) — Model failure.
#
# Injection: a deliberately invalid `model` in the request body
# (`does/not-exist`, the plan's literal example) - task-request.schema.json
# already had an optional `model` field (plan §4.1); this phase threaded it
# through init-run.yaml's agent_result_initialize.model ->
# run-agent.yaml's effective_agent_model (request-level override takes
# precedence over the job-level `agent_model` default).
#
# Required outcome: agent-runtime retries per its existing bounded policy
# (packages/agent-runtime/src/retry.ts - max_attempts default 3,
# exponential backoff 1s/2s/4s, MODEL_INVOCATION_FAILED is retryable) then
# exits 20 ("model invocation failed after all retries") - bounded and
# explicit, never an infinite hang. No retry-count change was made for
# this scenario (existing policy proven, not special-cased).
#
# planner-agent runs first, so it is expected to be the one that fails.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
source ./e2e-6-lib.sh

log "[6.3] Waiting for Run API..."
e6_wait_for_run_api || exit 1

log "[6.3] POST /runs (model=does/not-exist)..."
RUN_ID=$(e6_post_run "Say hello in one sentence." "does/not-exist") || exit 1
log "[6.3] run_id=$RUN_ID"

START_TS=$(date +%s)
STATUS_JSON=$(e6_poll_terminal "$RUN_ID") || exit 1
END_TS=$(date +%s)
ELAPSED=$((END_TS - START_TS))
e6_print_jobs "$STATUS_JSON"
log "[6.3] Buildset reached terminal state in ${ELAPSED}s (bounded, not an infinite hang)."

PLANNER_RESULT=$(e6_job_result "$STATUS_JSON" planner-agent)
if [ "$PLANNER_RESULT" != "FAILURE" ]; then
  log "[6.3] FAILED: planner-agent result=$PLANNER_RESULT (expected FAILURE from an invalid model name)"
  exit 1
fi
log "[6.3] planner-agent: FAILURE (as required)"

for job in coder-agent tool-validation reviewer-agent; do
  RESULT=$(e6_job_result "$STATUS_JSON" "$job")
  if [ "$RESULT" != "SKIPPED" ]; then
    log "[6.3] FAILED: job '$job' result=$RESULT (expected SKIPPED)"
    exit 1
  fi
  log "[6.3] $job: SKIPPED (as required)"
done

LOG_URL=$(e6_job_log_url "$STATUS_JSON" planner-agent)
if [ -z "$LOG_URL" ]; then
  log "[6.3] FAILED: planner-agent has no log_url"
  exit 1
fi
# job-output.json is always published by base's post-logs.yaml regardless
# of build result - the exact exit code (20) and retry evidence live in the
# Ansible console output there.
CONSOLE_CODE=$(e6_fetch_status "${LOG_URL%/}/job-output.json")
if [ "$CONSOLE_CODE" != "200" ]; then
  log "[6.3] FAILED: console output (job-output.json) not published at ${LOG_URL%/}/job-output.json (HTTP $CONSOLE_CODE)"
  exit 1
fi
CONSOLE_BODY=$(curl -s "${LOG_URL%/}/job-output.json")
if ! echo "$CONSOLE_BODY" | grep -q "exit 20"; then
  log "[6.3] FAILED: console output does not mention 'exit 20' - cannot confirm agent-runtime's exit code"
  log "[6.3] (console excerpt below for diagnosis)"
  echo "$CONSOLE_BODY" | grep -i "agent-runtime\|opencode exited" >&2 || true
  exit 1
fi
log "[6.3] PASSED: agent-runtime exited 20 (model invocation failed after bounded retries), confirmed via console output."
exit 0
