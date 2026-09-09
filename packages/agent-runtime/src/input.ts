import { readFileSync } from "node:fs";
import { validateAgentInput, formatErrors, type AgentInput } from "@repo/agent-contracts";
import { RuntimeError, ExitCode } from "./types.js";

/** Loads and validates the --input manifest. Throws RuntimeError(10) on failure. */
export function loadAgentInput(inputPath: string): AgentInput {
  let raw: string;
  try {
    raw = readFileSync(inputPath, "utf-8");
  } catch (err) {
    throw new RuntimeError(ExitCode.INPUT_INVALID, `cannot read --input ${inputPath}: ${String(err)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new RuntimeError(ExitCode.INPUT_INVALID, `--input ${inputPath} is not valid JSON: ${String(err)}`);
  }

  const result = validateAgentInput(parsed);
  if (!result.valid || !result.data) {
    throw new RuntimeError(
      ExitCode.INPUT_INVALID,
      `--input ${inputPath} failed schema validation: ${formatErrors(result.errors)}`,
    );
  }
  return result.data;
}

/** Loads the --prompt role template. Throws RuntimeError(11) on failure. */
export function loadPromptTemplate(promptPath: string): string {
  try {
    return readFileSync(promptPath, "utf-8");
  } catch (err) {
    throw new RuntimeError(ExitCode.PROMPT_UNREADABLE, `cannot read --prompt ${promptPath}: ${String(err)}`);
  }
}
