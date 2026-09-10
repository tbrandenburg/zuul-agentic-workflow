// Shared secret-detection regex set (docs/PLAN.md §6 check 6, §9 "Secret
// redaction"). Single source of truth reused by both
// `packages/agent-runtime/src/redact.ts` (output redaction) and
// `packages/agent-tools/src/secrets.ts` (Phase 4 deterministic validation
// check 6) - see Phase 4 task notes for why this lives here rather than in
// either consumer: both packages already depend on `@repo/agent-contracts`,
// so extracting here avoids a new cross-dependency and avoids duplicating
// regexes (DRY).
export const SECRET_PATTERNS: RegExp[] = [
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
