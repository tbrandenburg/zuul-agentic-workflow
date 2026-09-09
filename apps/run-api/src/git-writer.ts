import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const BRANCH = "refs/heads/agent-runs";
const BRANCH_SHORT = "agent-runs";
const MAX_ATTEMPTS = 3;

export interface PushResult {
  oldrev: string;
  newrev: string;
}

/**
 * Hand-rolled async mutex: a promise chain that serializes callers one at
 * a time (plan §8/§13-Q3). No extra dependency — matches the repo's
 * zero-deps-for-subprocess-orchestration philosophy.
 */
class Mutex {
  private tail: Promise<void> = Promise.resolve();

  async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release: () => void = () => {};
    this.tail = new Promise((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

const pushMutex = new Mutex();

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

function ensureBranchCheckedOut(clonePath: string, repoPath: string): void {
  try {
    git(["rev-parse", "--verify", `origin/${BRANCH_SHORT}`], clonePath);
    git(["checkout", "-B", BRANCH_SHORT, `origin/${BRANCH_SHORT}`], clonePath);
    return;
  } catch {
    // Branch does not exist yet on the remote — create it as an orphan
    // with an empty initial commit (plan §1.8: the branch is created once,
    // never via a zero-oldrev enqueue-ref).
    git(["checkout", "--orphan", BRANCH_SHORT], clonePath);
    git(["commit", "--allow-empty", "-m", `init ${BRANCH_SHORT}`], clonePath);
    git(["push", "origin", `HEAD:${BRANCH}`], clonePath);
    void repoPath;
  }
}

/**
 * Clones `repoPath`'s `refs/heads/agent-runs` branch into a scratch dir,
 * appends `runs/<runId>/request.json`, commits, and pushes fast-forward
 * only. Retries the whole clone-append-commit-push cycle up to
 * MAX_ATTEMPTS times on non-fast-forward rejection. Serialized across
 * concurrent callers by an in-process mutex.
 */
export async function pushRun(repoPath: string, runId: string, requestJson: unknown): Promise<PushResult> {
  return pushMutex.runExclusive(async () => attemptPushCycle(repoPath, runId, requestJson, 1));
}

async function attemptPushCycle(
  repoPath: string,
  runId: string,
  requestJson: unknown,
  attempt: number,
): Promise<PushResult> {
  const cloneDir = mkdtempSync(path.join(tmpdir(), "agent-runs-clone-"));
  try {
    git(["clone", "--quiet", repoPath, cloneDir], tmpdir());
    ensureBranchCheckedOut(cloneDir, repoPath);

    const oldrev = git(["rev-parse", "HEAD"], cloneDir);

    const runDir = path.join(cloneDir, "runs", runId);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(path.join(runDir, "request.json"), `${JSON.stringify(requestJson, null, 2)}\n`, "utf-8");

    git(["add", "."], cloneDir);
    git(["-c", "user.email=run-api@local", "-c", "user.name=run-api", "commit", "-m", `run ${runId}`], cloneDir);

    const newrev = git(["rev-parse", "HEAD"], cloneDir);

    try {
      git(["push", "origin", `HEAD:${BRANCH}`], cloneDir);
      return { oldrev, newrev };
    } catch (err) {
      if (attempt >= MAX_ATTEMPTS) {
        throw new Error(`pushRun: push rejected after ${String(attempt)} attempts: ${String(err)}`);
      }
      return attemptPushCycle(repoPath, runId, requestJson, attempt + 1);
    }
  } finally {
    rmSync(cloneDir, { recursive: true, force: true });
  }
}
