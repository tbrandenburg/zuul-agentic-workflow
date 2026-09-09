import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { checkWorkspaceConfinement } from "../src/workspace.js";
import { RuntimeError } from "../src/types.js";

function git(args: string[], cwd: string): void {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}

describe("checkWorkspaceConfinement", () => {
  let repo: string;
  let baseSha: string;

  beforeAll(() => {
    repo = mkdtempSync(path.join(tmpdir(), "workspace-confinement-"));
    git(["init", "-q"], repo);
    git(["-c", "user.email=t@t.com", "-c", "user.name=t", "commit", "--allow-empty", "-m", "init"], repo);
    baseSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf-8" }).trim();
  });

  afterAll(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("does nothing when base_sha is absent", () => {
    expect(() => checkWorkspaceConfinement(repo, undefined, "read-only")).not.toThrow();
  });

  it("does nothing for a read-write workspace regardless of changes", () => {
    writeFileSync(path.join(repo, "scratch.txt"), "hello");
    expect(() => checkWorkspaceConfinement(repo, baseSha, "read-write")).not.toThrow();
  });

  it("throws RuntimeError(40) for a read-only workspace with any diff vs base_sha", () => {
    writeFileSync(path.join(repo, "unexpected-write.txt"), "should not exist");
    expect(() => checkWorkspaceConfinement(repo, baseSha, "read-only")).toThrow(RuntimeError);
    try {
      checkWorkspaceConfinement(repo, baseSha, "read-only");
    } catch (err) {
      expect((err as RuntimeError).code).toBe(40);
      expect((err as RuntimeError).message).toContain("unexpected-write.txt");
    }
  });

  it("does nothing when the workspace path is not a git repo", () => {
    const nonRepo = mkdtempSync(path.join(tmpdir(), "not-a-repo-"));
    try {
      expect(() => checkWorkspaceConfinement(nonRepo, "deadbeef", "read-only")).not.toThrow();
    } finally {
      rmSync(nonRepo, { recursive: true, force: true });
    }
  });
});
