import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, symlinkSync } from "node:fs";
import path from "node:path";
import os from "node:os";

/**
 * Throwaway-clone helpers (docs/PLAN.md §6, "Critically: step 3 applies the
 * patch to a throwaway clone inside the job workspace. The sandbox target
 * repo is never mutated in place."). Every function here either operates on
 * a freshly-created temp directory or accepts one explicitly - none of them
 * ever write into the original `repoRoot`.
 */

export interface ThrowawayClone {
  dir: string;
  cleanup: () => void;
}

/** Clones `repoRoot` (read-only, never mutated) into a fresh temp directory. */
export function createThrowawayClone(repoRoot: string): ThrowawayClone {
  const dir = mkdtempSync(path.join(os.tmpdir(), "agent-tools-clone-"));
  // `-c safe.directory=*`: repoRoot may be a host-owned bind mount (e.g.
  // Zuul's /repo) accessed from inside a container - git's "dubious
  // ownership" protection otherwise refuses to even read it. Passing the
  // override on the command line (not via a mounted ~/.gitconfig or
  // GIT_CONFIG_* env vars) is the most robust option: it works regardless
  // of what environment/filesystem visibility the calling process has
  // (proven necessary in a Zuul trusted-project sandbox, see
  // zuul/zuul-config/playbooks/run-agent.yaml's equivalent comment).
  execFileSync("git", ["-c", "safe.directory=*", "clone", "--quiet", "--no-hardlinks", repoRoot, dir], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  // node_modules is gitignored, so a plain `git clone` never carries it -
  // symlink (never copy) the ORIGINAL repo's node_modules into the clone so
  // `npm run lint`/`npm test` inside the clone's service directory can
  // still resolve tools (e.g. eslint) hoisted at the monorepo root, without
  // a slow reinstall and without ever writing anything back into
  // `repoRoot` itself (a symlink target is read-only from the clone's
  // perspective).
  const originalNodeModules = path.join(repoRoot, "node_modules");
  if (existsSync(originalNodeModules)) {
    symlinkSync(originalNodeModules, path.join(dir, "node_modules"), "dir");
  }
  return {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

export function checkoutSha(cloneDir: string, sha: string): void {
  execFileSync("git", ["-c", "safe.directory=*", "checkout", "--quiet", sha], {
    cwd: cloneDir,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

export interface GitApplyResult {
  ok: boolean;
  message: string;
}

export function gitApplyCheck(cloneDir: string, patchPath: string): GitApplyResult {
  try {
    execFileSync("git", ["apply", "--check", patchPath], { cwd: cloneDir, stdio: ["ignore", "pipe", "pipe"] });
    return { ok: true, message: "patch applies cleanly (git apply --check)" };
  } catch (err) {
    return { ok: false, message: extractStderr(err) };
  }
}

export function gitApply(cloneDir: string, patchPath: string): GitApplyResult {
  try {
    execFileSync("git", ["apply", patchPath], { cwd: cloneDir, stdio: ["ignore", "pipe", "pipe"] });
    return { ok: true, message: "patch applied" };
  } catch (err) {
    return { ok: false, message: extractStderr(err) };
  }
}

function extractStderr(err: unknown): string {
  if (err && typeof err === "object" && "stderr" in err) {
    const stderr = (err as { stderr?: Buffer | string }).stderr;
    if (stderr) return stderr.toString().trim();
  }
  return err instanceof Error ? err.message : String(err);
}
