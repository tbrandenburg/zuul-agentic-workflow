const REDACTED = "***REDACTED***";

const PATTERNS: RegExp[] = [
  // AWS access key IDs
  /AKIA[0-9A-Z]{16}/g,
  // Generic api_key/api-key/apikey = or : value
  /(api[_-]?key\s*[:=]\s*)([^\s"'`,)]+)/gi,
  // Bearer tokens
  /(Bearer\s+)([A-Za-z0-9\-._~+/]+=*)/g,
  // Generic secret/token = value assignments
  /((?:secret|token|password)\s*[:=]\s*)([^\s"'`,)]+)/gi,
  // PEM private key blocks
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

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
