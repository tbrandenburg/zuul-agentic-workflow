import { spawn } from "node:child_process";
import { RuntimeError, ExitCode } from "./types.js";

export interface OpencodeInvocation {
  model: string;
  workspace: string;
  prompt: string;
  timeoutMs: number;
  maxOutputBytes: number;
  /** Overridable for tests; defaults to "opencode". */
  binary?: string;
}

export interface OpencodeOutcome {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

const KILL_GRACE_MS = 2000;

/**
 * Invokes `opencode run --format json --pure --model <model> --dir
 * <workspace> <prompt>` via spawn. Captures stdout/stderr into separate
 * buffers, enforces timeoutMs (SIGTERM then SIGKILL after a grace period),
 * and enforces maxOutputBytes on stdout.
 *
 * Throws RuntimeError(21) on timeout, RuntimeError(22) on output overflow.
 * A non-zero/null exit code is returned (not thrown) so the caller can
 * classify it as a transport failure for the retry policy.
 */
export async function invokeOpencode(invocation: OpencodeInvocation): Promise<OpencodeOutcome> {
  const binary = invocation.binary ?? "opencode";
  const args = [
    "run",
    "--format",
    "json",
    "--pure",
    "--model",
    invocation.model,
    "--dir",
    invocation.workspace,
    invocation.prompt,
  ];

  return new Promise<OpencodeOutcome>((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"] });

    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let settled = false;
    let timedOut = false;
    let oversized = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!settled) child.kill("SIGKILL");
      }, KILL_GRACE_MS);
    }, invocation.timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > invocation.maxOutputBytes) {
        oversized = true;
        child.kill("SIGTERM");
        return;
      }
      stdout += chunk.toString("utf-8");
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf-8");
    });

    child.on("error", (err) => {
      settled = true;
      clearTimeout(timer);
      reject(new RuntimeError(ExitCode.MODEL_INVOCATION_FAILED, `failed to spawn opencode: ${String(err)}`));
    });

    child.on("close", (code) => {
      settled = true;
      clearTimeout(timer);
      if (timedOut) {
        reject(new RuntimeError(ExitCode.TIMEOUT, `opencode invocation exceeded timeout_ms=${invocation.timeoutMs}`));
        return;
      }
      if (oversized) {
        reject(
          new RuntimeError(
            ExitCode.OUTPUT_TOO_LARGE,
            `opencode stdout exceeded max_output_bytes=${invocation.maxOutputBytes}`,
          ),
        );
        return;
      }
      resolve({ stdout, stderr, exitCode: code });
    });
  });
}
