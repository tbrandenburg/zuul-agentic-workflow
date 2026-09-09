import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { executeRun, type RunArgs } from "../src/run.js";
import { validateAgentResult } from "@repo/agent-contracts";

const PROMPT = "# Role: Planner\nDo the trivial task.\n";

function makeDirs(): { dir: string; workspace: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "agent-runtime-it-"));
  const workspace = path.join(dir, "workspace");
  mkdirSync(workspace, { recursive: true });
  return { dir, workspace };
}

function writeInput(dir: string, overrides: Record<string, unknown> = {}): string {
  const file = path.join(dir, "agent-input.json");
  const base = {
    schema_version: 1,
    run_id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    role: "planner",
    task: { description: "Say hello in one sentence.", repo: "agent-runs", base_ref: "main" },
    workspace: { path: path.join(dir, "workspace"), mode: "read-only" },
    model: "opencode/big-pickle",
    ...overrides,
  };
  writeFileSync(file, JSON.stringify(base));
  return file;
}

function baseArgs(dir: string, inputFile: string, fixture: string): RunArgs {
  return {
    role: "planner",
    input: inputFile,
    output: path.join(dir, "agent-result.json"),
    prompt: path.join(dir, "planner.md"),
    model: "opencode/big-pickle",
    mock: true,
    mockFixture: fixture,
  };
}

const cleanupDirs: string[] = [];
afterEach(() => {
  while (cleanupDirs.length > 0) {
    const d = cleanupDirs.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  }
});

function setup(
  fixture: string,
  limitsOverride: Record<string, unknown> = {},
): { dir: string; inputFile: string; args: RunArgs } {
  const { dir } = makeDirs();
  cleanupDirs.push(dir);
  writeFileSync(path.join(dir, "planner.md"), PROMPT);
  const inputFile = writeInput(dir, Object.keys(limitsOverride).length > 0 ? { limits: limitsOverride } : {});
  const args = baseArgs(dir, inputFile, fixture);
  return { dir, inputFile, args };
}

describe("executeRun exit codes (mock mode, all 7 fixtures)", () => {
  it("exit 0: valid fixture writes a schema-valid agent-result.json", async () => {
    const { dir, args } = setup("valid");
    const code = await executeRun(args);
    expect(code).toBe(0);
    const written: unknown = JSON.parse(readFileSync(args.output, "utf-8"));
    const validated = validateAgentResult(written);
    expect(validated.valid).toBe(true);
    void dir;
  });

  it("exit 30: malformed-json fixture (unparseable fenced block)", async () => {
    const { args } = setup("malformed-json", { max_attempts: 1 });
    expect(await executeRun(args)).toBe(30);
  });

  it("exit 30: missing-required-field fixture (schema-invalid result)", async () => {
    const { args } = setup("missing-required-field", { max_attempts: 1 });
    expect(await executeRun(args)).toBe(30);
  });

  it("exit 30: empty-output fixture (no fenced block at all)", async () => {
    const { args } = setup("empty-output", { max_attempts: 1 });
    expect(await executeRun(args)).toBe(30);
  });

  it("exit 22: oversized-output fixture exceeds max_output_bytes", async () => {
    const { args } = setup("oversized-output", { max_attempts: 1, max_output_bytes: 1000 });
    expect(await executeRun(args)).toBe(22);
  });

  it("exit 21: timeout fixture simulates exceeding timeout_ms", async () => {
    const { args } = setup("timeout", { max_attempts: 1, timeout_ms: 5 });
    expect(await executeRun(args)).toBe(21);
  });

  it("exit 20: nonzero-exit fixture (opencode process fails)", async () => {
    const { args } = setup("nonzero-exit", { max_attempts: 1 });
    expect(await executeRun(args)).toBe(20);
  });
});

describe("executeRun exit codes (input/prompt/workspace)", () => {
  it("exit 10: --input fails schema validation", async () => {
    const { dir } = makeDirs();
    cleanupDirs.push(dir);
    writeFileSync(path.join(dir, "planner.md"), PROMPT);
    const inputFile = path.join(dir, "agent-input.json");
    writeFileSync(inputFile, JSON.stringify({ schema_version: 1 }));
    const args = baseArgs(dir, inputFile, "valid");
    expect(await executeRun(args)).toBe(10);
  });

  it("exit 11: --prompt file missing", async () => {
    const { dir } = makeDirs();
    cleanupDirs.push(dir);
    const inputFile = writeInput(dir);
    const args = baseArgs(dir, inputFile, "valid");
    args.prompt = path.join(dir, "does-not-exist.md");
    expect(await executeRun(args)).toBe(11);
  });

  it("exit 40: read-only workspace with an untracked change vs base_sha", async () => {
    const { dir } = makeDirs();
    cleanupDirs.push(dir);
    writeFileSync(path.join(dir, "planner.md"), PROMPT);
    const workspace = path.join(dir, "workspace");
    execFileSync("git", ["init", "-q"], { cwd: workspace });
    execFileSync("git", ["-c", "user.email=t@t.com", "-c", "user.name=t", "commit", "--allow-empty", "-m", "init"], {
      cwd: workspace,
    });
    const baseSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: workspace, encoding: "utf-8" }).trim();

    const inputFile = writeInput(dir, {
      task: { description: "Say hello in one sentence.", repo: "agent-runs", base_ref: "main", base_sha: baseSha },
      workspace: { path: workspace, mode: "read-only" },
    });

    // Simulate the model having written outside its read-only confinement.
    writeFileSync(path.join(workspace, "unexpected.txt"), "oops");

    const args = baseArgs(dir, inputFile, "valid");
    args.output = path.join(dir, "agent-result.json");
    expect(await executeRun(args)).toBe(40);
  });
});
