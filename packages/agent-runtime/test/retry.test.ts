import { describe, it, expect, vi } from "vitest";
import { withRetry } from "../src/retry.js";
import { RuntimeError, ExitCode } from "../src/types.js";

describe("withRetry", () => {
  it("retries retryable failures up to maxAttempts then rethrows the last error", async () => {
    let calls = 0;
    const sleep = vi.fn(() => Promise.resolve());
    await expect(
      withRetry(
        async () => {
          calls++;
          throw new RuntimeError(ExitCode.TIMEOUT, "always times out");
        },
        { maxAttempts: 3, sleep, random: () => 0.5 },
      ),
    ).rejects.toMatchObject({ code: ExitCode.TIMEOUT });
    expect(calls).toBe(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("applies exponential backoff with jitter between attempts", async () => {
    const sleep = vi.fn(() => Promise.resolve());
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw new RuntimeError(ExitCode.NORMALIZE_FAILED, "malformed");
        },
        { maxAttempts: 3, sleep, random: () => 0 }, // random=0 -> jitterFactor 0.8
      ),
    ).rejects.toThrow();
    expect(calls).toBe(3);
    expect(sleep).toHaveBeenNthCalledWith(1, 800); // 1000 * 0.8
    expect(sleep).toHaveBeenNthCalledWith(2, 1600); // 2000 * 0.8
  });

  it("does not retry a non-retryable failure (e.g. oversized output)", async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw new RuntimeError(ExitCode.OUTPUT_TOO_LARGE, "too big");
        },
        { maxAttempts: 3 },
      ),
    ).rejects.toMatchObject({ code: ExitCode.OUTPUT_TOO_LARGE });
    expect(calls).toBe(1);
  });

  it("returns the value on eventual success within the attempt budget", async () => {
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls++;
        if (calls < 2) throw new RuntimeError(ExitCode.TIMEOUT, "flaky");
        return "ok";
      },
      { maxAttempts: 3, sleep: () => Promise.resolve() },
    );
    expect(result).toBe("ok");
    expect(calls).toBe(2);
  });

  it("never retries a plain (non-RuntimeError) exception", async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw new Error("boom");
        },
        { maxAttempts: 3 },
      ),
    ).rejects.toThrow("boom");
    expect(calls).toBe(1);
  });
});
