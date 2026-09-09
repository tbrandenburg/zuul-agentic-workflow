import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RuntimeError, ExitCode } from "./types.js";
import type { OpencodeOutcome } from "./opencode.js";

const here = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_FIXTURES_DIR = path.join(here, "..", "fixtures");

export interface MockOptions {
  fixture: string;
  maxOutputBytes: number;
  fixturesDir?: string;
  /** Injectable for tests so the timeout fixture doesn't actually sleep 15min. */
  sleep?: (ms: number) => Promise<void>;
  timeoutMs: number;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Replays a recorded NDJSON fixture instead of invoking the real opencode
 * CLI (plan §5.4). The `timeout` fixture is simulated by sleeping past
 * `timeoutMs` rather than shipping a real 900s wait; the `nonzero-exit`
 * fixture returns exitCode 1 with the fixture's stdout content.
 */
export async function runMock(options: MockOptions): Promise<OpencodeOutcome> {
  const fixturesDir = options.fixturesDir ?? DEFAULT_FIXTURES_DIR;
  const sleep = options.sleep ?? defaultSleep;

  if (options.fixture === "timeout") {
    await sleep(options.timeoutMs + 1);
    throw new RuntimeError(
      ExitCode.TIMEOUT,
      `mock fixture 'timeout' simulated exceeding timeout_ms=${options.timeoutMs}`,
    );
  }

  const filePath = path.join(fixturesDir, `${options.fixture}.ndjson`);
  let content: string;
  try {
    content = readFileSync(filePath, "utf-8");
  } catch (err) {
    throw new RuntimeError(
      ExitCode.MODEL_INVOCATION_FAILED,
      `unknown mock fixture '${options.fixture}': ${String(err)}`,
    );
  }

  if (Buffer.byteLength(content, "utf-8") > options.maxOutputBytes) {
    throw new RuntimeError(
      ExitCode.OUTPUT_TOO_LARGE,
      `mock fixture '${options.fixture}' output exceeded max_output_bytes=${options.maxOutputBytes}`,
    );
  }

  if (options.fixture === "nonzero-exit") {
    return { stdout: content, stderr: "simulated non-zero exit\n", exitCode: 1 };
  }

  return { stdout: content, stderr: "", exitCode: 0 };
}
