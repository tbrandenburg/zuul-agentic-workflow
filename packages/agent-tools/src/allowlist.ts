/**
 * Changed-file allowlist check (docs/PLAN.md §6 check 4). `agent-input
 * .schema.json` does not currently thread `allowed_paths` end-to-end (a
 * documented Phase 2/3 stand-in - see `packages/agent-runtime/src
 * /workspace.ts`'s own comment on the same gap), so this check reads
 * `allowed_paths` straight from the ORIGINAL `runs/<id>/request.json` if the
 * field is present there, and otherwise defaults to "anything under
 * `<serviceDir>/`" - `serviceDir` being the sandbox service directory this
 * run's `repo` field named (e.g. `sandbox/services/example`). This keeps
 * the allowlist meaningful even for the common case (no `allowed_paths`
 * supplied at all) without requiring a schema change in this phase.
 */
export function resolveAllowedPaths(requestAllowedPaths: string[] | undefined, serviceDir: string): string[] {
  if (requestAllowedPaths && requestAllowedPaths.length > 0) {
    return requestAllowedPaths;
  }
  return [serviceDir.endsWith("/") ? serviceDir : `${serviceDir}/`];
}

export function isPathAllowed(filePath: string, allowedPaths: readonly string[]): boolean {
  return allowedPaths.some((allowed) => {
    const normalized = allowed.endsWith("/") ? allowed : `${allowed}/`;
    return filePath === allowed || filePath.startsWith(normalized);
  });
}

export function findDisallowedFiles(files: readonly string[], allowedPaths: readonly string[]): string[] {
  return files.filter((f) => !isPathAllowed(f, allowedPaths));
}

/**
 * Forbidden-path check (docs/PLAN.md §6 check 5): these are never allowed
 * to be touched by a patch, regardless of `allowed_paths`.
 */
const FORBIDDEN_PATTERNS: RegExp[] = [
  /(^|\/)\.git\//,
  /\.pem$/,
  /(^|\/)\.env(\..+)?$/,
  /(^|\/)\.github\//,
  /(^|\/)\.gitlab-ci\.ya?ml$/,
  /(^|\/)zuul\//,
];

export function findForbiddenFiles(files: readonly string[]): string[] {
  return files.filter((f) => FORBIDDEN_PATTERNS.some((p) => p.test(f)));
}
