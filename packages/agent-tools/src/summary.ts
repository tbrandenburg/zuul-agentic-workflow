import type { CheckResult, ValidationReport } from "./types.js";
import { CHECK_NAMES, WARNING_ONLY_CHECKS } from "./types.js";

/** Builds the final report, deriving `passed` from FAILURE-severity checks only. */
export function buildReport(checks: CheckResult[]): ValidationReport {
  const passed = checks.every((c) => c.status !== "FAIL");
  return { schema_version: 1, passed, checks };
}

/** A PASS/FAIL/WARN placeholder for a check that never ran because an earlier fail-fast check stopped the pipeline. */
export function skippedCheck(name: (typeof CHECK_NAMES)[number], reason: string): CheckResult {
  const status = WARNING_ONLY_CHECKS.has(name) ? "WARN" : "FAIL";
  return { name, status, message: `skipped: ${reason}` };
}

export function toMarkdown(report: ValidationReport): string {
  const lines: string[] = [];
  lines.push("# Validation report", "");
  lines.push(`**Overall: ${report.passed ? "PASSED" : "FAILED"}**`, "");
  lines.push("| # | Check | Status | Message |", "|---|---|---|---|");
  report.checks.forEach((c, i) => {
    lines.push(`| ${i + 1} | ${c.name} | ${c.status} | ${escapeMd(c.message)} |`);
  });
  lines.push("");
  return lines.join("\n");
}

function escapeMd(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\n/g, " ");
}
