// Phase 4 deterministic validation (docs/PLAN.md §6) - library surface for
// tests/reuse. `agent-tools validate` (cli.ts) is the executable entrypoint;
// this module never triggers a CLI run on import.
export { runValidation, type ValidateOptions } from "./validate.js";
export { buildReport, toMarkdown, skippedCheck } from "./summary.js";
export { parseUnifiedDiff, type ParsedDiff } from "./patch.js";
export { resolveAllowedPaths, isPathAllowed, findDisallowedFiles, findForbiddenFiles } from "./allowlist.js";
export { scanForSecrets, type SecretMatch } from "./secrets.js";
export { crossCheckClaims } from "./claims.js";
export { createThrowawayClone, checkoutSha, gitApplyCheck, gitApply } from "./clone.js";
export type { CheckResult, CheckStatus, ValidationReport, CheckName } from "./types.js";
export { CHECK_NAMES, WARNING_ONLY_CHECKS } from "./types.js";
