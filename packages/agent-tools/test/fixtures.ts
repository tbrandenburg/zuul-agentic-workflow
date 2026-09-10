import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";

/**
 * Builds a throwaway git fixture repo shaped like the real
 * `sandbox/services/example` (a `service/` dir with a trivial add() +
 * a plain-node lint/test script pair, so tests never depend on eslint
 * actually being installed in whatever directory the fixture lives in -
 * see `packages/agent-tools/src/clone.ts`'s node_modules-symlink comment
 * for why the REAL sandbox dir needs that; these fixtures sidestep it by
 * using dependency-free lint/test scripts instead).
 */
export interface Fixture {
  repoRoot: string;
  serviceDir: string;
  baseSha: string;
  cleanup: () => void;
}

const SERVICE_DIR = "sandbox/services/example";

export function buildFixtureRepo(): Fixture {
  const repoRoot = mkdtempSync(path.join(os.tmpdir(), "agent-tools-fixture-"));
  const git = (...args: string[]): string =>
    execFileSync("git", args, { cwd: repoRoot, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });

  git("init", "--quiet");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");

  const svcDir = path.join(repoRoot, SERVICE_DIR);
  mkdirSync(svcDir, { recursive: true });
  writeFileSync(path.join(svcDir, "index.js"), ["export function add(a, b) {", "  return a + b;", "}", ""].join("\n"));
  writeFileSync(
    path.join(svcDir, "package.json"),
    `${JSON.stringify(
      {
        name: "fixture-example",
        private: true,
        type: "module",
        scripts: {
          // Dependency-free stand-ins for the real repo's eslint/node --test
          // commands - fails if index.js contains the literal string "TODO".
          lint: "node -e \"const fs=require('fs');const s=fs.readFileSync('index.js','utf8');if(s.includes('TODO')){process.exit(1)}\"",
          test: "node --test",
        },
      },
      null,
      2,
    )}\n`,
  );
  mkdirSync(path.join(svcDir, "test"), { recursive: true });
  writeFileSync(
    path.join(svcDir, "test", "add.test.js"),
    [
      "import { test } from 'node:test';",
      "import assert from 'node:assert/strict';",
      "import { add } from '../index.js';",
      "",
      "test('adds', () => { assert.equal(add(2, 3), 5); });",
      "",
    ].join("\n"),
  );

  git("add", "-A");
  git("commit", "--quiet", "-m", "initial fixture commit");
  const baseSha = git("rev-parse", "HEAD").trim();

  return {
    repoRoot,
    serviceDir: SERVICE_DIR,
    baseSha,
    cleanup: () => rmSync(repoRoot, { recursive: true, force: true }),
  };
}

/**
 * Generates a real unified diff (via `git diff --cached`) for arbitrary
 * file mutations applied on top of the fixture's `baseSha`, using a
 * separate scratch working copy so the fixture repo itself is never
 * mutated (mirrors the production "never mutate in place" rule for the
 * tests themselves, not just the code under test).
 */
export function generatePatch(fixture: Fixture, mutate: (workDir: string) => void): string {
  const workDir = mkdtempSync(path.join(os.tmpdir(), "agent-tools-fixture-work-"));
  const git = (...args: string[]): string =>
    execFileSync("git", args, { cwd: workDir, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
  try {
    execFileSync("git", ["clone", "--quiet", fixture.repoRoot, workDir], { stdio: ["ignore", "pipe", "pipe"] });
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "Test");
    mutate(workDir);
    git("add", "-A");
    return git("diff", "--cached", "--no-color");
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

export function validAgentResult(): Record<string, unknown> {
  return {
    schema_version: 1,
    run_id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    agent: "coder",
    status: "success",
    summary: "Added a doc comment above add().",
    claims: [
      { statement: "add() is unchanged behaviourally", verifiable: true, evidence: "diff shows comment-only change" },
    ],
    files: ["sandbox/services/example/index.js"],
    next_actions: [],
    confidence: 0.9,
  };
}
