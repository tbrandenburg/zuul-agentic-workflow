import { SECRET_PATTERNS } from "@repo/agent-contracts";

const REDACTED = "***REDACTED***";

// Phase 4: extracted to packages/agent-contracts/src/secret-patterns.ts so
// packages/agent-tools/src/secrets.ts can reuse the exact same regex set
// (docs/PLAN.md §6 check 6) instead of duplicating it.
const PATTERNS: RegExp[] = SECRET_PATTERNS;

/** Applies a regex-based secret-redaction pass over a single string. */
export function redactString(input: string): string {
  let out = input;
  for (const pattern of PATTERNS) {
    out = out.replace(pattern, (match, ...groups: unknown[]) => {
      // Patterns with capture groups keep the label prefix, redact only the value.
      if (typeof groups[0] === "string" && groups.length >= 2) {
        return `${groups[0]}${REDACTED}`;
      }
      return REDACTED;
    });
  }
  return out;
}

/** Recursively redacts every string value in an object/array in place-safe fashion. */
export function redactDeep<T>(value: T): T {
  if (typeof value === "string") {
    return redactString(value) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((item: unknown) => redactDeep(item)) as unknown as T;
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      out[key] = redactDeep(val);
    }
    return out as T;
  }
  return value;
}
