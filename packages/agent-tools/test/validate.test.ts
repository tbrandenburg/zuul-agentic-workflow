import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { runValidation } from "../src/validate.js";
import { buildFixtureRepo, generatePatch, validAgentResult, type Fixture } from "./fixtures.js";

function writeTemp(name: string, content: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "agent-tools-test-"));
  const p = path.join(dir, name);
  writeFileSync(p, content);
  return p;
}

function resultFile(overrides: Record<string, unknown> = {}): string {
  return writeTemp("agent-result.json", JSON.stringify({ ...validAgentResult(), ...overrides }));
}

describe("agent-tools validate (docs/PLAN.md §6, 9 ordered checks)", () => {
  let fixture: Fixture;

  afterEach(() => {
    fixture?.cleanup();
  });

  it("PASSES all 9 checks for a genuinely good patch, and never mutates the fixture repo", () => {
    fixture = buildFixtureRepo();
    const patch = generatePatch(fixture, (workDir) => {
      const file = path.join(workDir, fixture.serviceDir, "index.js");
      writeFileSync(
        file,
        ["/** Adds two numbers. */", "export function add(a, b) {", "  return a + b;", "}", ""].join("\n"),
      );
    });
    const patchPath = writeTemp("patch.diff", patch);
    const beforeStatus = execFileSync("git", ["status", "--porcelain"], { cwd: fixture.repoRoot, encoding: "utf-8" });
    expect(beforeStatus).toBe("");

    const { checks, passed } = runValidation({
      patchPath,
      resultPath: resultFile(),
      repoRoot: fixture.repoRoot,
      serviceDir: fixture.serviceDir,
      baseSha: fixture.baseSha,
    });

    expect(checks.map((c) => `${c.name}=${c.status}`)).toEqual([
      "schema=PASS",
      "patch-non-empty=PASS",
      "patch-applies=PASS",
      "allowlist=PASS",
      "forbidden-paths=PASS",
      "secret-scan=PASS",
      "lint=PASS",
      "test=PASS",
      "claims-cross-check=PASS",
    ]);
    expect(passed).toBe(true);

    // The fixture repo itself must be byte-identical / untouched afterwards.
    const afterStatus = execFileSync("git", ["status", "--porcelain"], { cwd: fixture.repoRoot, encoding: "utf-8" });
    expect(afterStatus).toBe("");
  });

  it("FAILS at check 1 (schema) on a malformed agent-result.json", () => {
    fixture = buildFixtureRepo();
    const patch = generatePatch(fixture, (workDir) => {
      writeFileSync(
        path.join(workDir, fixture.serviceDir, "index.js"),
        "export function add(a, b) { return a + b; }\n",
      );
    });
    const badResult = writeTemp("agent-result.json", JSON.stringify({ schema_version: 1, agent: "coder" }));
    const { checks, passed } = runValidation({
      patchPath: writeTemp("patch.diff", patch),
      resultPath: badResult,
      repoRoot: fixture.repoRoot,
      serviceDir: fixture.serviceDir,
      baseSha: fixture.baseSha,
    });
    expect(passed).toBe(false);
    expect(checks[0]).toMatchObject({ name: "schema", status: "FAIL" });
    expect(checks[0]?.message).toMatch(/schema validation failed/);
  });

  it("FAILS at check 2 (patch-non-empty) on an empty patch.diff", () => {
    fixture = buildFixtureRepo();
    const { checks, passed } = runValidation({
      patchPath: writeTemp("patch.diff", ""),
      resultPath: resultFile(),
      repoRoot: fixture.repoRoot,
      serviceDir: fixture.serviceDir,
      baseSha: fixture.baseSha,
    });
    expect(passed).toBe(false);
    const c = checks.find((c) => c.name === "patch-non-empty");
    expect(c).toMatchObject({ status: "FAIL" });
    expect(c?.message).toMatch(/empty or missing/);
    expect(checks.find((c) => c.name === "schema")?.status).toBe("PASS");
  });

  it("FAILS at check 3 (patch-applies) on a patch with mismatched context", () => {
    fixture = buildFixtureRepo();
    const bogusPatch = [
      `diff --git a/${fixture.serviceDir}/index.js b/${fixture.serviceDir}/index.js`,
      "index 0000000..1111111 100644",
      `--- a/${fixture.serviceDir}/index.js`,
      `+++ b/${fixture.serviceDir}/index.js`,
      "@@ -1,3 +1,3 @@",
      "-export function totallyDifferentFunctionName(a, b) {",
      "+export function add(a, b) {",
      "   return a + b;",
      " }",
      "",
    ].join("\n");
    const { checks, passed } = runValidation({
      patchPath: writeTemp("patch.diff", bogusPatch),
      resultPath: resultFile(),
      repoRoot: fixture.repoRoot,
      serviceDir: fixture.serviceDir,
      baseSha: fixture.baseSha,
    });
    expect(passed).toBe(false);
    const c = checks.find((c) => c.name === "patch-applies");
    expect(c?.status).toBe("FAIL");
    expect(checks.find((c) => c.name === "patch-non-empty")?.status).toBe("PASS");

    // The fixture repo must remain untouched even after a failed apply attempt.
    const status = execFileSync("git", ["status", "--porcelain"], { cwd: fixture.repoRoot, encoding: "utf-8" });
    expect(status).toBe("");
  });

  it("FAILS at check 4 (allowlist) when the patch touches a file outside sandbox/services/example", () => {
    fixture = buildFixtureRepo();
    const patch = generatePatch(fixture, (workDir) => {
      writeFileSync(path.join(workDir, "TOP-LEVEL.md"), "not allowed\n");
    });
    const { checks, passed } = runValidation({
      patchPath: writeTemp("patch.diff", patch),
      resultPath: resultFile(),
      repoRoot: fixture.repoRoot,
      serviceDir: fixture.serviceDir,
      baseSha: fixture.baseSha,
    });
    expect(passed).toBe(false);
    const c = checks.find((c) => c.name === "allowlist");
    expect(c?.status).toBe("FAIL");
    expect(c?.message).toMatch(/TOP-LEVEL\.md/);
    expect(checks.find((c) => c.name === "patch-applies")?.status).toBe("PASS");
  });

  it("FAILS at check 5 (forbidden-paths) when the patch touches a forbidden path inside the allowed dir", () => {
    fixture = buildFixtureRepo();
    const patch = generatePatch(fixture, (workDir) => {
      writeFileSync(path.join(workDir, fixture.serviceDir, ".env"), "SECRET=1\n");
    });
    const { checks, passed } = runValidation({
      patchPath: writeTemp("patch.diff", patch),
      resultPath: resultFile(),
      repoRoot: fixture.repoRoot,
      serviceDir: fixture.serviceDir,
      baseSha: fixture.baseSha,
    });
    expect(passed).toBe(false);
    expect(checks.find((c) => c.name === "allowlist")?.status).toBe("PASS");
    const c = checks.find((c) => c.name === "forbidden-paths");
    expect(c?.status).toBe("FAIL");
    expect(c?.message).toMatch(/\.env/);
  });

  it("FAILS at check 6 (secret-scan) when the patch introduces an AWS-shaped key", () => {
    fixture = buildFixtureRepo();
    const patch = generatePatch(fixture, (workDir) => {
      writeFileSync(
        path.join(workDir, fixture.serviceDir, "index.js"),
        ["export function add(a, b) {", "  // AKIAABCDEFGHIJKLMNOP", "  return a + b;", "}", ""].join("\n"),
      );
    });
    const { checks, passed } = runValidation({
      patchPath: writeTemp("patch.diff", patch),
      resultPath: resultFile(),
      repoRoot: fixture.repoRoot,
      serviceDir: fixture.serviceDir,
      baseSha: fixture.baseSha,
    });
    expect(passed).toBe(false);
    expect(checks.find((c) => c.name === "forbidden-paths")?.status).toBe("PASS");
    const c = checks.find((c) => c.name === "secret-scan");
    expect(c?.status).toBe("FAIL");
    expect(c?.message).toMatch(/AKIA/);
  });

  it("FAILS at check 7 (lint) when the patch introduces a TODO the fixture's lint script rejects", () => {
    fixture = buildFixtureRepo();
    const patch = generatePatch(fixture, (workDir) => {
      writeFileSync(
        path.join(workDir, fixture.serviceDir, "index.js"),
        ["// TODO: revisit", "export function add(a, b) {", "  return a + b;", "}", ""].join("\n"),
      );
    });
    const { checks, passed } = runValidation({
      patchPath: writeTemp("patch.diff", patch),
      resultPath: resultFile(),
      repoRoot: fixture.repoRoot,
      serviceDir: fixture.serviceDir,
      baseSha: fixture.baseSha,
    });
    expect(passed).toBe(false);
    expect(checks.find((c) => c.name === "secret-scan")?.status).toBe("PASS");
    const c = checks.find((c) => c.name === "lint");
    expect(c?.status).toBe("FAIL");
  });

  it("FAILS at check 8 (test) when the patch breaks behaviour", () => {
    fixture = buildFixtureRepo();
    const patch = generatePatch(fixture, (workDir) => {
      writeFileSync(
        path.join(workDir, fixture.serviceDir, "index.js"),
        ["export function add(a, b) {", "  return a - b; // bug", "}", ""].join("\n"),
      );
    });
    const { checks, passed } = runValidation({
      patchPath: writeTemp("patch.diff", patch),
      resultPath: resultFile(),
      repoRoot: fixture.repoRoot,
      serviceDir: fixture.serviceDir,
      baseSha: fixture.baseSha,
    });
    expect(passed).toBe(false);
    expect(checks.find((c) => c.name === "lint")?.status).toBe("PASS");
    const c = checks.find((c) => c.name === "test");
    expect(c?.status).toBe("FAIL");
  });

  it("check 9 (claims-cross-check) is WARN-only and never fails the overall report", () => {
    fixture = buildFixtureRepo();
    const patch = generatePatch(fixture, (workDir) => {
      writeFileSync(
        path.join(workDir, fixture.serviceDir, "index.js"),
        ["/** doc */", "export function add(a, b) {", "  return a + b;", "}", ""].join("\n"),
      );
    });
    const result = resultFile({
      claims: [{ statement: "I verified everything", verifiable: true }],
    });
    const { checks, passed } = runValidation({
      patchPath: writeTemp("patch.diff", patch),
      resultPath: result,
      repoRoot: fixture.repoRoot,
      serviceDir: fixture.serviceDir,
      baseSha: fixture.baseSha,
    });
    const c = checks.find((c) => c.name === "claims-cross-check");
    expect(c?.status).toBe("WARN");
    expect(passed).toBe(true);
  });

  it("respects allowed_paths from the original request.json when present", () => {
    fixture = buildFixtureRepo();
    const patch = generatePatch(fixture, (workDir) => {
      writeFileSync(path.join(workDir, "OTHER-ALLOWED.md"), "hi\n");
    });
    const requestPath = writeTemp("request.json", JSON.stringify({ allowed_paths: ["OTHER-ALLOWED.md"] }));
    const { checks, passed } = runValidation({
      patchPath: writeTemp("patch.diff", patch),
      resultPath: resultFile({ files: ["OTHER-ALLOWED.md"] }),
      requestPath,
      repoRoot: fixture.repoRoot,
      serviceDir: fixture.serviceDir,
      baseSha: fixture.baseSha,
    });
    // allowlist passes because OTHER-ALLOWED.md is in the explicit
    // allowed_paths - but lint/test then run against sandbox/services/example
    // (the serviceDir), which the patch never touched, so lint/test still
    // pass trivially against the unmodified fixture code.
    expect(checks.find((c) => c.name === "allowlist")?.status).toBe("PASS");
    expect(passed).toBe(true);
  });
});
