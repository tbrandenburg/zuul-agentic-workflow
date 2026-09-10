#!/usr/bin/env bash
# Phase 6 (docs/PLAN.md §11.8): `make demo` - scripted happy-path run +
# transcript. Runs a fresh happy-path request through the real Run API
# (same request shape as e2e-6-1-happy-path.sh) and captures a readable,
# timestamped transcript of the whole flow (POST /runs response, polling
# progress, final run-summary.md content) to a git-ignored file under
# zuul/.demo-transcripts/ (repo-relative but gitignored - see .gitignore).
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
source ./e2e-6-lib.sh

OUT_DIR="$ROOT_DIR/.demo-transcripts"
mkdir -p "$OUT_DIR"
TS="$(date -u +%Y%m%dT%H%M%SZ)"
TRANSCRIPT="$OUT_DIR/demo-transcript-$TS.txt"

{
  echo "=== Zuul Agentic Workflow - Demo Transcript ==="
  echo "Generated (UTC): $TS"
  echo "Run API: $RUN_API_URL"
  echo

  echo "--- 1. Waiting for Run API ---"
  e6_wait_for_run_api || { echo "Run API not reachable"; exit 1; }
  echo "Run API is healthy."
  echo

  echo "--- 2. POST /runs ---"
  TASK="Add a one-line comment above the add function in index.js explaining what it does."
  echo "Task: $TASK"
  RUN_ID=$(e6_post_run "$TASK") || { echo "POST /runs failed"; exit 1; }
  echo "Response: run_id=$RUN_ID (ULID-shaped, HTTP 202)"
  echo

  echo "--- 3. Polling GET /runs/$RUN_ID until terminal ---"
  STATUS_JSON=$(e6_poll_terminal "$RUN_ID") || { echo "Polling timed out"; exit 1; }
  STATUS=$(echo "$STATUS_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin)['status'])")
  echo "Terminal buildset status: $STATUS"
  e6_print_jobs "$STATUS_JSON" 2>&1
  echo

  echo "--- 4. GET /runs/$RUN_ID/summary (run-summary.json) ---"
  SUMMARY_JSON=$(curl -s "$RUN_API_URL/runs/$RUN_ID/summary")
  echo "$SUMMARY_JSON" | python3 -m json.tool
  echo

  echo "--- 5. run-summary.md (fetched from the summary artifact) ---"
  SUMMARY_LOG_URL=$(e6_job_log_url "$STATUS_JSON" publish-run-summary)
  if [ -n "$SUMMARY_LOG_URL" ]; then
    curl -s "${SUMMARY_LOG_URL%/}/artifacts/summary/run-summary.md"
  else
    echo "(publish-run-summary log_url unavailable - could not fetch run-summary.md)"
  fi
  echo
  echo "--- End of transcript ---"
} | tee "$TRANSCRIPT"

echo "Transcript saved to: $TRANSCRIPT" >&2
