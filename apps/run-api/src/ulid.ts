// Minimal Crockford-base32 ULID generator (26 chars, timestamp + random),
// matching agent-input.schema.json's `run_id` pattern
// `^[0-9A-HJKMNP-TV-Z]{26}$` (plan §11 task 5.4 / fact #7 in the task
// brief). Hand-rolled rather than adding the `ulid` npm dependency -
// consistent with the repo's zero-deps-for-small-utilities philosophy
// (see git-writer.ts's hand-rolled Mutex for the same rationale).
import { randomBytes } from "node:crypto";

const CROCKFORD_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function encodeTime(time: number, length: number): string {
  let remaining = time;
  let out = "";
  for (let i = length - 1; i >= 0; i -= 1) {
    const mod = remaining % 32;
    out = CROCKFORD_ALPHABET.charAt(mod) + out;
    remaining = Math.floor(remaining / 32);
  }
  return out;
}

function encodeRandom(length: number): string {
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i += 1) {
    out += CROCKFORD_ALPHABET.charAt(bytes[i]! % 32);
  }
  return out;
}

/** Generates a 26-character ULID: 10 chars of millisecond timestamp + 16 chars of randomness. */
export function generateUlid(now: number = Date.now()): string {
  return encodeTime(now, 10) + encodeRandom(16);
}
