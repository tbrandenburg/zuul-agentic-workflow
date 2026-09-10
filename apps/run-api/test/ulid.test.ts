import { describe, it, expect } from "vitest";
import { generateUlid } from "../src/ulid.js";

describe("generateUlid", () => {
  it("produces a 26-character Crockford-base32 string matching agent-input.schema.json's run_id pattern", () => {
    const id = generateUlid();
    expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it("is lexicographically sortable by timestamp", () => {
    const a = generateUlid(1_000_000);
    const b = generateUlid(2_000_000);
    expect(a < b).toBe(true);
  });

  it("produces distinct ids for repeated calls at the same millisecond", () => {
    const now = Date.now();
    const ids = new Set(Array.from({ length: 50 }, () => generateUlid(now)));
    expect(ids.size).toBe(50);
  });
});
