export type CheckStatus = "PASS" | "FAIL" | "WARN";

export interface CheckResult {
  name: string;
  status: CheckStatus;
  message: string;
}

export interface ValidationReport {
  schema_version: 1;
  passed: boolean;
  checks: CheckResult[];
}

/** The ordered check names, matching docs/PLAN.md §6's table exactly. */
export const CHECK_NAMES = [
  "schema",
  "patch-non-empty",
  "patch-applies",
  "allowlist",
  "forbidden-paths",
  "secret-scan",
  "lint",
  "test",
  "claims-cross-check",
] as const;

export type CheckName = (typeof CHECK_NAMES)[number];

/** Checks 1-8 are FAILURE severity; check 9 (claims-cross-check) is WARNING-only. */
export const WARNING_ONLY_CHECKS: ReadonlySet<CheckName> = new Set(["claims-cross-check"]);
