import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { validateAgentResult, formatErrors, type AgentResult } from "@repo/agent-contracts";
import { parseUnifiedDiff } from "./patch.js";
import { resolveAllowedPaths, findDisallowedFiles, findForbiddenFiles } from "./allowlist.js";
import { scanForSecrets } from "./secrets.js";
import { createThrowawayClone, checkoutSha, gitApplyCheck, gitApply } from "./clone.js";
import { runLint } from "./lint.js";
import { runTests } from "./test.js";
import { crossCheckClaims } from "./claims.js";
import { buildReport, skippedCheck } from "./summary.js";
import type { CheckResult, CheckName } from "./types.js";
import { CHECK_NAMES } from "./types.js";

export interface ValidateOptions {
  patchPath: string;
  resultPath: string;
  requestPath?: string;
  repoRoot: string;
  serviceDir: string;
  baseSha: string;
}

interface RequestJson {
  allowed_paths?: string[];
}

/**
 * Runs all 9 deterministic checks (docs/PLAN.md §6) in order, fail-fast on
 * the first FAILURE-severity check (1-8). Check 9 is WARNING-only and
 * always runs last if 1-8 all passed - it never blocks `passed`.
 */
export function runValidation(opts: ValidateOptions): { checks: CheckResult[]; passed: boolean } {
  const checks: CheckResult[] = [];
  let stoppedAt: CheckName | null = null;

  // Check 1: schema
  let resultRaw = "";
  let result: AgentResult | null = null;
  try {
    resultRaw = readFileSync(opts.resultPath, "utf-8");
    const parsed: unknown = JSON.parse(resultRaw);
    const v = validateAgentResult(parsed);
    if (v.valid) {
      result = v.data;
      checks.push({ name: "schema", status: "PASS", message: "agent-result.json validates against schema" });
    } else {
      checks.push({ name: "schema", status: "FAIL", message: `schema validation failed: ${formatErrors(v.errors)}` });
      stoppedAt = "schema";
    }
  } catch (err) {
    checks.push({ name: "schema", status: "FAIL", message: `could not read/parse agent-result.json: ${msg(err)}` });
    stoppedAt = "schema";
  }

  // Check 2: patch non-empty + parses
  let patchText = "";
  let changedFiles: string[] = [];
  if (!stoppedAt) {
    patchText = existsSync(opts.patchPath) ? readFileSync(opts.patchPath, "utf-8") : "";
    if (patchText.trim().length === 0) {
      checks.push({ name: "patch-non-empty", status: "FAIL", message: "patch.diff is empty or missing" });
      stoppedAt = "patch-non-empty";
    } else {
      const parsed = parseUnifiedDiff(patchText);
      if (!parsed) {
        checks.push({
          name: "patch-non-empty",
          status: "FAIL",
          message: "patch.diff does not parse as a unified diff (no 'diff --git' headers found)",
        });
        stoppedAt = "patch-non-empty";
      } else {
        changedFiles = parsed.files;
        checks.push({
          name: "patch-non-empty",
          status: "PASS",
          message: `patch is non-empty and parses (${String(parsed.files.length)} file(s), ${String(parsed.hunkCount)} hunk(s))`,
        });
      }
    }
  }

  // Check 3: git apply --check against base_sha, in a throwaway clone (never mutates repoRoot)
  let clone: ReturnType<typeof createThrowawayClone> | null = null;
  if (!stoppedAt) {
    clone = createThrowawayClone(opts.repoRoot);
    try {
      checkoutSha(clone.dir, opts.baseSha);
    } catch (err) {
      checks.push({
        name: "patch-applies",
        status: "FAIL",
        message: `could not checkout base_sha ${opts.baseSha} in throwaway clone: ${msg(err)}`,
      });
      stoppedAt = "patch-applies";
    }
    if (!stoppedAt) {
      const absPatchPath = path.resolve(opts.patchPath);
      const applyCheck = gitApplyCheck(clone.dir, absPatchPath);
      if (!applyCheck.ok) {
        checks.push({ name: "patch-applies", status: "FAIL", message: applyCheck.message });
        stoppedAt = "patch-applies";
      } else {
        checks.push({ name: "patch-applies", status: "PASS", message: applyCheck.message });
      }
    }
  }

  // Check 4: changed-file allowlist
  if (!stoppedAt) {
    let requestAllowedPaths: string[] | undefined;
    if (opts.requestPath && existsSync(opts.requestPath)) {
      try {
        const req = JSON.parse(readFileSync(opts.requestPath, "utf-8")) as RequestJson;
        requestAllowedPaths = req.allowed_paths;
      } catch {
        requestAllowedPaths = undefined;
      }
    }
    const allowedPaths = resolveAllowedPaths(requestAllowedPaths, opts.serviceDir);
    const disallowed = findDisallowedFiles(changedFiles, allowedPaths);
    if (disallowed.length > 0) {
      checks.push({
        name: "allowlist",
        status: "FAIL",
        message: `file(s) outside allowed_paths (${allowedPaths.join(", ")}): ${disallowed.join(", ")}`,
      });
      stoppedAt = "allowlist";
    } else {
      checks.push({
        name: "allowlist",
        status: "PASS",
        message: `all ${String(changedFiles.length)} changed file(s) within allowed_paths (${allowedPaths.join(", ")})`,
      });
    }
  }

  // Check 5: forbidden paths
  if (!stoppedAt) {
    const forbidden = findForbiddenFiles(changedFiles);
    if (forbidden.length > 0) {
      checks.push({
        name: "forbidden-paths",
        status: "FAIL",
        message: `patch touches forbidden path(s): ${forbidden.join(", ")}`,
      });
      stoppedAt = "forbidden-paths";
    } else {
      checks.push({ name: "forbidden-paths", status: "PASS", message: "no forbidden paths touched" });
    }
  }

  // Check 6: secret scan (patch + result artifact text)
  if (!stoppedAt) {
    const found = scanForSecrets({ "patch.diff": patchText, "agent-result.json": resultRaw });
    if (found.length > 0) {
      checks.push({
        name: "secret-scan",
        status: "FAIL",
        message: `possible secret(s) found: ${found.map((f) => `${f.source} matched /${f.pattern}/`).join("; ")}`,
      });
      stoppedAt = "secret-scan";
    } else {
      checks.push({ name: "secret-scan", status: "PASS", message: "no secret patterns found in patch or artifacts" });
    }
  }

  // Checks 7 & 8: lint + test on the patched tree, in the SAME throwaway clone
  if (!stoppedAt && clone) {
    const absPatchPath = path.resolve(opts.patchPath);
    const applied = gitApply(clone.dir, absPatchPath);
    if (!applied.ok) {
      // Should not happen given check 3 already passed --check, but fail closed if it does.
      checks.push({ name: "lint", status: "FAIL", message: `could not apply patch for lint/test: ${applied.message}` });
      stoppedAt = "lint";
    } else {
      const serviceCloneDir = path.join(clone.dir, opts.serviceDir);
      const lintOutcome = runLint(serviceCloneDir);
      if (!lintOutcome.ok) {
        checks.push({ name: "lint", status: "FAIL", message: lintOutcome.message });
        stoppedAt = "lint";
      } else {
        checks.push({ name: "lint", status: "PASS", message: lintOutcome.message || "lint passed" });

        const testOutcome = runTests(serviceCloneDir);
        if (!testOutcome.ok) {
          checks.push({ name: "test", status: "FAIL", message: testOutcome.message });
          stoppedAt = "test";
        } else {
          checks.push({ name: "test", status: "PASS", message: testOutcome.message || "tests passed" });
        }
      }
    }
  }

  clone?.cleanup();

  // Check 9: claims cross-check - WARNING only, runs regardless of whether
  // 1-8 all passed, EXCEPT if we never even got a parsed `result` (check 1
  // itself failed), in which case there is nothing to cross-check.
  if (result) {
    const outcome = crossCheckClaims(result);
    checks.push({ name: "claims-cross-check", status: outcome.ok ? "PASS" : "WARN", message: outcome.message });
  } else {
    checks.push(skippedCheck("claims-cross-check", "agent-result.json did not parse/validate"));
  }

  // Fill in skipped placeholders for any FAILURE-severity checks that never ran.
  const ranNames = new Set(checks.map((c) => c.name));
  for (const name of CHECK_NAMES) {
    if (!ranNames.has(name)) {
      checks.push(skippedCheck(name, `earlier check '${stoppedAt ?? "unknown"}' failed`));
    }
  }

  // Re-order to match CHECK_NAMES canonical order for a stable report.
  const ordered = CHECK_NAMES.map((name) => checks.find((c) => c.name === name)).filter(
    (c): c is CheckResult => c !== undefined,
  );

  const report = buildReport(ordered);
  return { checks: report.checks, passed: report.passed };
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
