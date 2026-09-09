import { validateAgentResult, formatErrors, type AgentResult } from "@repo/agent-contracts";
import { RuntimeError, ExitCode, type NormalizeOutcome, type StepFinishTelemetry } from "./types.js";

/**
 * Parses an NDJSON opencode event stream. Unparseable lines and unknown
 * `type` values are skipped (recorded as warnings), never fatal (plan
 * §13/Q5 finding #3). Concatenates `part.text` from consecutive `text`
 * events in order, then trims the result (finding #1). Extracts
 * `part.tokens`/`part.cost` from the LAST `step_finish` event, never
 * summed across steps (finding #2).
 */
export function parseNdjson(stdout: string): NormalizeOutcome {
  const warnings: string[] = [];
  const textParts: string[] = [];
  let telemetry: Partial<StepFinishTelemetry> = {};

  const lines = stdout.split("\n");
  for (const line of lines) {
    if (line.trim().length === 0) continue;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      warnings.push(`skipped unparseable NDJSON line: ${line.slice(0, 120)}`);
      continue;
    }
    if (!isRecord(event) || typeof event["type"] !== "string") {
      warnings.push("skipped NDJSON line with no string 'type' field");
      continue;
    }
    const type = event["type"];
    if (type === "text") {
      const part = event["part"];
      if (isRecord(part) && typeof part["text"] === "string") {
        textParts.push(part["text"]);
      }
      continue;
    }
    if (type === "step_finish") {
      const part = event["part"];
      if (isRecord(part)) {
        telemetry = extractTelemetry(part);
      }
      continue;
    }
    // skip-unknown-type by default (step_start, tool_use, error,
    // permission-request, and anything future — plan §13/Q5).
  }

  return { text: textParts.join("").trim(), telemetry, warnings };
}

function extractTelemetry(part: Record<string, unknown>): Partial<StepFinishTelemetry> {
  const telemetry: Partial<StepFinishTelemetry> = {};
  const tokens = part["tokens"];
  if (isRecord(tokens)) {
    if (typeof tokens["input"] === "number") telemetry.tokens_input = tokens["input"];
    if (typeof tokens["output"] === "number") telemetry.tokens_output = tokens["output"];
  }
  if (typeof part["cost"] === "number") telemetry.cost = part["cost"];
  return telemetry;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Extracts the LAST fenced ```json block from text. Returns null if none. */
export function extractLastJsonBlock(text: string): string | null {
  const re = /```json\s*\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  let last: string | null = null;
  while ((match = re.exec(text)) !== null) {
    last = match[1] ?? null;
  }
  return last === null ? null : last.trim();
}

/**
 * Normalises the raw NDJSON stdout into a validated AgentResult. Throws
 * RuntimeError(30) fail-closed on any failure (no partial result written).
 */
export function normalizeResult(stdout: string): {
  result: AgentResult;
  telemetryPartial: Partial<StepFinishTelemetry>;
  warnings: string[];
} {
  const { text, telemetry, warnings } = parseNdjson(stdout);

  const block = extractLastJsonBlock(text);
  if (block === null) {
    throw new RuntimeError(ExitCode.NORMALIZE_FAILED, "no fenced ```json block found in model output");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(block);
  } catch (err) {
    throw new RuntimeError(ExitCode.NORMALIZE_FAILED, `fenced json block did not parse: ${String(err)}`);
  }

  const validated = validateAgentResult(parsed);
  if (!validated.valid || !validated.data) {
    throw new RuntimeError(
      ExitCode.NORMALIZE_FAILED,
      `model output failed agent-result schema validation: ${formatErrors(validated.errors)}`,
    );
  }

  return { result: validated.data, telemetryPartial: telemetry, warnings };
}
