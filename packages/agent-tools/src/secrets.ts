import { SECRET_PATTERNS } from "@repo/agent-contracts";

/**
 * Secret scan (docs/PLAN.md §6 check 6): reuses the exact same regex set as
 * `packages/agent-runtime/src/redact.ts` (extracted to
 * `@repo/agent-contracts/secret-patterns` so both sides stay identical -
 * see that module's own comment). Scans the patch text plus every artifact
 * string handed in (agent-result.json's raw text, any captured stdout/
 * stderr logs, etc).
 */
export interface SecretMatch {
  source: string;
  pattern: string;
}

export function scanForSecrets(sources: Record<string, string>): SecretMatch[] {
  const matches: SecretMatch[] = [];
  for (const [name, text] of Object.entries(sources)) {
    for (const pattern of SECRET_PATTERNS) {
      // Each SECRET_PATTERNS regex is defined with the `g` flag and reused
      // across calls, so reset lastIndex before testing a fresh string.
      pattern.lastIndex = 0;
      if (pattern.test(text)) {
        matches.push({ source: name, pattern: pattern.source });
      }
    }
  }
  return matches;
}
