import { describe, it, expect } from "vitest";
import { redactString, redactDeep } from "../src/redact.js";

describe("redactString", () => {
  it("redacts AWS access key IDs", () => {
    const out = redactString("key is AKIAABCDEFGHIJKLMNOP end");
    expect(out).not.toContain("AKIAABCDEFGHIJKLMNOP");
    expect(out).toContain("REDACTED");
  });

  it("redacts api_key assignments while keeping the label", () => {
    const out = redactString("config: api_key=sk-superSecretValue123");
    expect(out).not.toContain("sk-superSecretValue123");
    expect(out).toContain("api_key=");
  });

  it("redacts bearer tokens", () => {
    const out = redactString("Authorization: Bearer abc123.def456-ghi");
    expect(out).not.toContain("abc123.def456-ghi");
    expect(out).toContain("Bearer ");
  });

  it("redacts PEM private key blocks", () => {
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIBogIBAAJ...\n-----END RSA PRIVATE KEY-----";
    const out = redactString(`here is a key:\n${pem}\ndone`);
    expect(out).not.toContain("MIIBogIBAAJ");
  });

  it("leaves ordinary text untouched", () => {
    expect(redactString("hello world, nothing secret here")).toBe("hello world, nothing secret here");
  });
});

describe("redactDeep", () => {
  it("redacts secrets nested inside objects and arrays", () => {
    const input = {
      summary: "token: abc",
      nested: { token: "token=verySecretValue", list: ["password=hunter2Value", "safe text"] },
    };
    const out = redactDeep(input);
    expect(JSON.stringify(out)).not.toContain("verySecretValue");
    expect(JSON.stringify(out)).not.toContain("hunter2Value");
    expect(out.nested.list[1]).toBe("safe text");
  });
});
