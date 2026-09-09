import { RuntimeError, ExitCode, type ExitCodeValue } from "./types.js";

const RETRYABLE_CODES: ReadonlySet<ExitCodeValue> = new Set([
  ExitCode.MODEL_INVOCATION_FAILED,
  ExitCode.TIMEOUT,
  ExitCode.NORMALIZE_FAILED,
]);

export interface RetryOptions {
  maxAttempts: number;
  /** Base backoff schedule in ms before jitter; index = attempt number (0-based). */
  backoffMs?: readonly number[];
  /** Injectable for tests; defaults to a real setTimeout-based sleep. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable RNG for deterministic jitter tests. */
  random?: () => number;
  onAttempt?: (attempt: number, error: unknown) => void;
}

const DEFAULT_BACKOFF_MS = [1000, 2000, 4000] as const;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retries `attempt` only for failure classes documented as retryable
 * (transport / timeout / malformed-output — plan §5.3 step 6). A
 * schema-valid `status: "failure"` result is never retried because it
 * never throws. Exponential backoff with ±20% jitter (1s, 2s, 4s).
 */
export async function withRetry<T>(attempt: (attemptNumber: number) => Promise<T>, options: RetryOptions): Promise<T> {
  const maxAttempts = Math.max(1, options.maxAttempts);
  const backoff = options.backoffMs ?? DEFAULT_BACKOFF_MS;
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;

  let lastError: unknown;
  for (let i = 0; i < maxAttempts; i++) {
    try {
      return await attempt(i + 1);
    } catch (err) {
      lastError = err;
      options.onAttempt?.(i + 1, err);

      const retryable = err instanceof RuntimeError && RETRYABLE_CODES.has(err.code);
      const isLastAttempt = i === maxAttempts - 1;
      if (!retryable || isLastAttempt) {
        throw err;
      }

      const base = backoff[Math.min(i, backoff.length - 1)] ?? 4000;
      const jitterFactor = 0.8 + random() * 0.4; // ±20%
      await sleep(Math.round(base * jitterFactor));
    }
  }
  // Unreachable, but satisfies control-flow analysis.
  throw lastError instanceof Error ? lastError : new Error("retry loop exhausted with no error captured");
}
