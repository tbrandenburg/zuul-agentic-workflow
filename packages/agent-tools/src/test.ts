import { runNpmScript, type CommandOutcome } from "./exec.js";

/** Check 8 (docs/PLAN.md §6): focused test command on the patched tree. */
export function runTests(serviceDir: string): CommandOutcome {
  return runNpmScript(serviceDir, "test");
}
