import { execFileSync } from "node:child_process";
import { RuntimeError, ExitCode } from "./types.js";

/**
 * Minimal workspace-confinement check (plan §5.5): if the workspace is a
 * git repo and `base_sha` is known, diff working tree against it and
 * reject any changed path outside `allowed_paths`. Kept simple per the
 * plan's explicit "doesn't need to be bulletproof yet" scope note.
 *
 * Design note: `agent-input.schema.json` (§4.2, copied verbatim from the
 * plan) does not carry `allowed_paths` — only `task-request.schema.json`
 * does, and it is not threaded through to the runtime in this phase. As a
 * practical stand-in, a `workspace.mode: "read-only"` manifest treats ANY
 * change vs `base_sha` as a violation (an allowlist of zero paths); a
 * `read-write` manifest is unrestricted by this check since we have no
 * allowlist to enforce against. Revisit once allowed_paths is threaded
 * through the initializer → agent-input path in a later phase.
 */
export function checkWorkspaceConfinement(
  workspacePath: string,
  baseSha: string | undefined,
  mode: "read-only" | "read-write",
  allowedPaths: readonly string[] = [],
): void {
  if (!baseSha) return;
  if (mode === "read-write") return;

  let changed: string[];
  try {
    const diffOut = execFileSync("git", ["diff", "--no-color", "--name-only", baseSha], {
      cwd: workspacePath,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const untrackedOut = execFileSync("git", ["ls-files", "--others", "--exclude-standard"], {
      cwd: workspacePath,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const all = new Set(
      [...diffOut.split("\n"), ...untrackedOut.split("\n")].map((l) => l.trim()).filter((l) => l.length > 0),
    );
    changed = Array.from(all);
  } catch {
    // Not a git repo (or base_sha not reachable) — nothing to confine against.
    return;
  }

  if (changed.length === 0) return;

  const violations = changed.filter((file) => !isAllowed(file, allowedPaths));
  if (violations.length > 0) {
    throw new RuntimeError(
      ExitCode.WORKSPACE_VIOLATION,
      `workspace change(s) outside allowed_paths: ${violations.join(", ")}`,
    );
  }
}

function isAllowed(file: string, allowedPaths: readonly string[]): boolean {
  if (allowedPaths.length === 0) return false;
  return allowedPaths.some(
    (allowed) => file === allowed || file.startsWith(allowed.endsWith("/") ? allowed : `${allowed}/`),
  );
}
