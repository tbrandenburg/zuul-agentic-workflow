import path from "node:path";
import { mkdirSync } from "node:fs";
import { loadAgentInput, loadPromptTemplate } from "./input.js";
import { composePrompt } from "./prompt.js";
import { invokeOpencode, type OpencodeOutcome } from "./opencode.js";
import { runMock } from "./mock.js";
import { normalizeResult } from "./normalize.js";
import { withRetry } from "./retry.js";
import { redactDeep, redactString } from "./redact.js";
import { checkWorkspaceConfinement } from "./workspace.js";
import { atomicWriteFile } from "./atomic-write.js";
import { RuntimeError, ExitCode, type StepFinishTelemetry } from "./types.js";
import type { AgentInput, AgentResult } from "@repo/agent-contracts";

export interface RunArgs {
  role: string;
  input: string;
  output: string;
  prompt: string;
  model: string;
  mock: boolean;
  mockFixture: string;
  workspace?: string;
  artifacts?: string;
}

const DEFAULT_TIMEOUT_MS = 900_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1_048_576;
const DEFAULT_MAX_ATTEMPTS = 3;

/** Thin wrapper so cli.ts and tests can reuse the exact same load path. */
export function loadAgentInputSafe(inputPath: string): AgentInput {
  return loadAgentInput(inputPath);
}

export function buildInvocation(input: AgentInput, args: RunArgs, prompt: string) {
  return {
    model: args.model,
    workspace: args.workspace ?? input.workspace.path,
    prompt,
    timeoutMs: input.limits?.timeout_ms ?? DEFAULT_TIMEOUT_MS,
    maxOutputBytes: input.limits?.max_output_bytes ?? DEFAULT_MAX_OUTPUT_BYTES,
  };
}

/**
 * Runs the full agent-runtime pipeline (plan §5.3) and returns the process
 * exit code. Never throws for documented failure modes — every RuntimeError
 * is caught here and converted to an exit code, per the CLI contract.
 */
export async function executeRun(args: RunArgs): Promise<number> {
  let input: AgentInput;
  let promptTemplate: string;
  try {
    input = loadAgentInputSafe(args.input);
    promptTemplate = loadPromptTemplate(args.prompt);
  } catch (err) {
    return handleKnownError(err);
  }

  const composed = composePrompt(promptTemplate, input);
  const invocation = buildInvocation(input, args, composed);
  const maxAttempts = input.limits?.max_attempts ?? DEFAULT_MAX_ATTEMPTS;

  const startedAt = Date.now();
  let attemptsTaken = 0;
  let lastOutcome: OpencodeOutcome | undefined;

  try {
    const { result, telemetryPartial } = await withRetry(
      async (attemptNumber) => {
        attemptsTaken = attemptNumber;
        const outcome = args.mock
          ? await runMock({
              fixture: args.mockFixture,
              maxOutputBytes: invocation.maxOutputBytes,
              timeoutMs: invocation.timeoutMs,
            })
          : await invokeOpencode(invocation);
        lastOutcome = outcome;

        if (outcome.exitCode !== 0) {
          throw new RuntimeError(
            ExitCode.MODEL_INVOCATION_FAILED,
            `opencode exited with code ${String(outcome.exitCode)}: ${outcome.stderr.slice(0, 500)}`,
          );
        }
        return normalizeResult(outcome.stdout);
      },
      { maxAttempts },
    );

    checkWorkspaceConfinement(invocation.workspace, input.task.base_sha, input.workspace.mode);

    const durationMs = Date.now() - startedAt;
    const telemetry: StepFinishTelemetry = {
      model: args.model,
      attempts: attemptsTaken,
      duration_ms: durationMs,
      tokens_input: telemetryPartial.tokens_input,
      tokens_output: telemetryPartial.tokens_output,
      cost: telemetryPartial.cost,
    };
    const finalResult: AgentResult = redactDeep({ ...result, telemetry });

    writeOutputs(args, finalResult, lastOutcome);
    return ExitCode.SUCCESS;
  } catch (err) {
    // Phase 6 (6.2 requirement): even on a failure that never reaches a
    // valid AgentResult (e.g. exit 30 - no fenced json block found), the
    // RAW model output must still be published so an operator can inspect
    // what the model actually said. writeOutputs() below only ran on the
    // success path before this fix, so a normalize/model failure silently
    // published nothing - a real gap relative to this requirement, fixed
    // here rather than assumed. Never overwrites --output (no valid
    // AgentResult exists in this branch), only the raw stdout/stderr logs.
    writeRawArtifacts(args, lastOutcome);
    return handleKnownError(err);
  }
}

function writeOutputs(args: RunArgs, result: AgentResult, outcome: OpencodeOutcome | undefined): void {
  atomicWriteFile(args.output, `${JSON.stringify(result, null, 2)}\n`);
  writeRawArtifacts(args, outcome);
}

function writeRawArtifacts(args: RunArgs, outcome: OpencodeOutcome | undefined): void {
  if (args.artifacts && outcome) {
    mkdirSync(args.artifacts, { recursive: true });
    atomicWriteFile(path.join(args.artifacts, "stdout.log"), redactString(outcome.stdout));
    atomicWriteFile(path.join(args.artifacts, "stderr.log"), redactString(outcome.stderr));
  }
}

function handleKnownError(err: unknown): number {
  if (err instanceof RuntimeError) {
    console.error(`[agent-runtime] exit ${err.code}: ${err.message}`);
    return err.code;
  }
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  return 1;
}
