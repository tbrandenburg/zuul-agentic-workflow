#!/usr/bin/env bash
# Gate E2E-2 (plan §11 Phase 2): agent-runtime run --role planner against
# the REAL opencode CLI, no --mock, no fixture. Costs real model tokens.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
runtime_dir="$repo_root/packages/agent-runtime"
work_dir="$(mktemp -d)"
trap 'rm -rf "$work_dir"' EXIT

echo "== E2E-2: building agent-runtime =="
(cd "$repo_root" && npm run build --workspace @repo/agent-contracts && npx tsc -b packages/agent-runtime)

mkdir -p "$work_dir/workspace"

input_file="$work_dir/agent-input.json"
output_file="$work_dir/agent-result-e2e2.json"
model="${AGENT_MODEL:-opencode/big-pickle}"

cat > "$input_file" <<JSON
{
  "schema_version": 1,
  "run_id": "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  "role": "planner",
  "task": {
    "description": "Say hello in one sentence.",
    "repo": "agent-runs",
    "base_ref": "main"
  },
  "workspace": { "path": "$work_dir/workspace", "mode": "read-only" },
  "model": "$model",
  "limits": { "timeout_ms": 120000, "max_attempts": 2 }
}
JSON

echo "== E2E-2: invoking real opencode ($model), no mock =="
node "$runtime_dir/dist/cli.js" run \
  --role planner \
  --input "$input_file" \
  --output "$output_file" \
  --prompt "$repo_root/prompts/planner.md" \
  --model "$model"

echo "== E2E-2: validating result =="
node --experimental-strip-types "$runtime_dir/scripts/assert-e2e2-result.ts" "$output_file"

echo "E2E-2 PASSED: $output_file"
