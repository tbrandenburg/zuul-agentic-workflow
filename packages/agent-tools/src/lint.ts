import { runNpmScript, type CommandOutcome } from "./exec.js";

/** Check 7 (docs/PLAN.md §6): formatter/linter on the patched tree. */
export function runLint(serviceDir: string): CommandOutcome {
  return runNpmScript(serviceDir, "lint");
}
