// Asserts the E2E-2 gate (plan §11 Phase 2): the written agent-result.json
// validates against agent-result.schema.json and carries non-zero
// telemetry proving a genuine model call (not a fixture).
import { readFileSync } from "node:fs";
import { validateAgentResult, formatErrors } from "@repo/agent-contracts";

const [, , outputFile] = process.argv;
if (!outputFile) {
  console.error("usage: assert-e2e2-result.ts <agent-result.json path>");
  process.exit(1);
}

const raw = JSON.parse(readFileSync(outputFile, "utf-8")) as unknown;
const validated = validateAgentResult(raw);
if (!validated.valid || !validated.data) {
  console.error(`agent-result.json failed schema validation: ${formatErrors(validated.errors)}`);
  process.exit(1);
}

const telemetry = validated.data.telemetry;
const tokensInput = telemetry?.tokens_input ?? 0;
const durationMs = telemetry?.duration_ms ?? 0;

if (tokensInput <= 0) {
  console.error(`E2E-2 FAILED: telemetry.tokens_input=${String(tokensInput)}, expected > 0 (proves a real model call)`);
  process.exit(1);
}
if (durationMs <= 0) {
  console.error(`E2E-2 FAILED: telemetry.duration_ms=${String(durationMs)}, expected > 0`);
  process.exit(1);
}

console.log(`E2E-2 assertions OK: tokens_input=${String(tokensInput)} duration_ms=${String(durationMs)}`);
