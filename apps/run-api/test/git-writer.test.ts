import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pushRun } from "../src/git-writer.js";

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

const cleanupDirs: string[] = [];
afterEach(() => {
  while (cleanupDirs.length > 0) {
    const d = cleanupDirs.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  }
});

function makeBareRepo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "agent-runs-bare-"));
  git(["init", "--bare", "-q"], dir);
  cleanupDirs.push(dir);
  return dir;
}

describe("pushRun against a real local bare git repo", () => {
  it("creates the agent-runs branch on first push and commits the request", async () => {
    const bareRepo = makeBareRepo();
    const result = await pushRun(bareRepo, "run-001", { task: "hello", repo: "agent-runs", base_ref: "main" });

    expect(result.oldrev).not.toBe(result.newrev);
    expect(result.newrev).toMatch(/^[0-9a-f]{40}$/);

    const checkout = mkdtempSync(path.join(tmpdir(), "agent-runs-checkout-"));
    cleanupDirs.push(checkout);
    git(["clone", "--quiet", "-b", "agent-runs", bareRepo, checkout], tmpdir());
    const filePath = path.join(checkout, "runs", "run-001", "request.json");
    expect(existsSync(filePath)).toBe(true);
    const written: unknown = JSON.parse(readFileSync(filePath, "utf-8"));
    expect(written).toMatchObject({ task: "hello", repo: "agent-runs", base_ref: "main" });

    const branchTip = git(["rev-parse", "refs/heads/agent-runs"], bareRepo);
    expect(branchTip).toBe(result.newrev);
  });

  it("fast-forwards the branch across sequential pushes", async () => {
    const bareRepo = makeBareRepo();
    const first = await pushRun(bareRepo, "run-a", { task: "first" });
    const second = await pushRun(bareRepo, "run-b", { task: "second" });

    expect(second.oldrev).toBe(first.newrev);

    const checkout = mkdtempSync(path.join(tmpdir(), "agent-runs-checkout-"));
    cleanupDirs.push(checkout);
    git(["clone", "--quiet", "-b", "agent-runs", bareRepo, checkout], tmpdir());
    expect(existsSync(path.join(checkout, "runs", "run-a", "request.json"))).toBe(true);
    expect(existsSync(path.join(checkout, "runs", "run-b", "request.json"))).toBe(true);
  });

  it("serializes concurrent pushes with no lost update", async () => {
    const bareRepo = makeBareRepo();
    const runIds = Array.from({ length: 8 }, (_, i) => `run-concurrent-${String(i)}`);

    const results = await Promise.all(runIds.map((id) => pushRun(bareRepo, id, { task: id })));

    // Every result must have a distinct newrev — no two concurrent pushes
    // collapsed onto the same commit, and none were silently dropped.
    const newrevs = new Set(results.map((r) => r.newrev));
    expect(newrevs.size).toBe(runIds.length);

    const checkout = mkdtempSync(path.join(tmpdir(), "agent-runs-checkout-"));
    cleanupDirs.push(checkout);
    git(["clone", "--quiet", "-b", "agent-runs", bareRepo, checkout], tmpdir());
    for (const id of runIds) {
      expect(existsSync(path.join(checkout, "runs", id, "request.json"))).toBe(true);
    }

    // The branch history must be a clean fast-forward chain: exactly
    // runIds.length + 1 commits (the orphan init + one per run), no merges.
    const log = git(["log", "--pretty=%H", "agent-runs"], checkout).split("\n").filter(Boolean);
    expect(log.length).toBe(runIds.length + 1);
  });
});
