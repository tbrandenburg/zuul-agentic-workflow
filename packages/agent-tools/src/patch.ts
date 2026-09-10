/**
 * Minimal unified-diff parsing (docs/PLAN.md §6 check 2 "patch.diff is
 * non-empty and parses as a unified diff"). Deliberately hand-rolled
 * (KISS/YAGNI) rather than pulling in a diff-parsing dependency: we only
 * need file-path extraction and a structural sanity check, not a full
 * patch-application engine (that part is delegated to the real `git apply`
 * binary in check 3, which is the actual source of truth for applicability).
 */

export interface ParsedDiff {
  /** Files touched, from `diff --git a/X b/Y` headers, deduplicated, order-preserved. */
  files: string[];
  hunkCount: number;
}

const GIT_DIFF_HEADER = /^diff --git a\/(.+?) b\/(.+)$/;
const HUNK_HEADER = /^@@ .* @@/;

/**
 * Parses a unified diff produced by `git diff`/`git format-patch`. Returns
 * `null` if the text does not look like a diff at all (no `diff --git`
 * headers found), which the caller treats as a FAIL for check 2.
 */
export function parseUnifiedDiff(patchText: string): ParsedDiff | null {
  const lines = patchText.split("\n");
  const files: string[] = [];
  const seen = new Set<string>();
  let hunkCount = 0;

  for (const line of lines) {
    const headerMatch = GIT_DIFF_HEADER.exec(line);
    if (headerMatch) {
      const bPath = headerMatch[2] ?? headerMatch[1];
      const filePath = bPath ?? "";
      if (filePath && !seen.has(filePath)) {
        seen.add(filePath);
        files.push(filePath);
      }
      continue;
    }
    if (HUNK_HEADER.test(line)) {
      hunkCount += 1;
    }
  }

  if (files.length === 0) return null;
  return { files, hunkCount };
}
