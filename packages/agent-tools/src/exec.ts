import { execFileSync } from "node:child_process";

export interface CommandOutcome {
  ok: boolean;
  message: string;
}

/**
 * Runs `npm run <script>` inside `cwd` (the patched throwaway clone's
 * service directory), used identically by check 7 (lint) and check 8
 * (test) - docs/PLAN.md §6: "run the sandbox repo's own lint/test command
 * against the throwaway clone, post-patch". We shell out to the service's
 * OWN `npm run lint`/`npm test` rather than hardcoding an eslint/node
 * invocation, so this check is agnostic to whatever tooling a given
 * sandbox service actually uses.
 */
export function runNpmScript(cwd: string, script: string, timeoutMs = 60_000): CommandOutcome {
  try {
    const output = execFileSync("npm", ["run", "--silent", script], {
      cwd,
      timeout: timeoutMs,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf-8",
    });
    return { ok: true, message: output.trim().slice(0, 2000) || `npm run ${script} passed` };
  } catch (err) {
    return { ok: false, message: extractOutput(err) };
  }
}

function extractOutput(err: unknown): string {
  if (err && typeof err === "object") {
    const e = err as { stdout?: Buffer | string; stderr?: Buffer | string };
    const combined = [e.stdout?.toString(), e.stderr?.toString()].filter(Boolean).join("\n");
    if (combined.trim()) return combined.trim().slice(0, 2000);
  }
  return err instanceof Error ? err.message : String(err);
}
