import { describe, it, expect } from "vitest";
import { parseNdjson, extractLastJsonBlock, normalizeResult } from "../src/normalize.js";
import { RuntimeError } from "../src/types.js";

describe("parseNdjson", () => {
  it("concatenates multiple text events in order and trims the result", () => {
    const stdout = [
      JSON.stringify({ type: "text", part: { text: "\n\n" } }),
      JSON.stringify({ type: "tool_use", part: { tool: "read" } }),
      JSON.stringify({ type: "step_start", part: {} }),
      JSON.stringify({ type: "text", part: { text: "DONE" } }),
    ].join("\n");
    const { text, warnings } = parseNdjson(stdout);
    expect(text).toBe("DONE");
    expect(warnings).toEqual([]);
  });

  it("skips malformed lines without throwing", () => {
    const stdout = ["not json at all", JSON.stringify({ type: "text", part: { text: "ok" } })].join("\n");
    const { text, warnings } = parseNdjson(stdout);
    expect(text).toBe("ok");
    expect(warnings.length).toBe(1);
  });

  it("skips unknown event types silently (no warning)", () => {
    const stdout = [
      JSON.stringify({ type: "permission-request", part: {} }),
      JSON.stringify({ type: "error", part: {} }),
      JSON.stringify({ type: "text", part: { text: "hi" } }),
    ].join("\n");
    const { text } = parseNdjson(stdout);
    expect(text).toBe("hi");
  });

  it("uses the LAST step_finish event for telemetry, never summed", () => {
    const stdout = [
      JSON.stringify({ type: "step_finish", part: { tokens: { input: 10, output: 5 }, cost: 0.1 } }),
      JSON.stringify({ type: "step_finish", part: { tokens: { input: 999, output: 111 }, cost: 9.9 } }),
    ].join("\n");
    const { telemetry } = parseNdjson(stdout);
    expect(telemetry.tokens_input).toBe(999);
    expect(telemetry.tokens_output).toBe(111);
    expect(telemetry.cost).toBe(9.9);
  });
});

describe("extractLastJsonBlock", () => {
  it("returns null when no fenced block is present", () => {
    expect(extractLastJsonBlock("just some prose")).toBeNull();
  });

  it("returns the LAST block when multiple are present", () => {
    const text = '```json\n{"a":1}\n```\nsome prose\n```json\n{"a":2}\n```';
    expect(extractLastJsonBlock(text)).toBe('{"a":2}');
  });

  it("ignores trailing prose after the block", () => {
    const text = '```json\n{"a":1}\n```\nthanks!';
    expect(extractLastJsonBlock(text)).toBe('{"a":1}');
  });
});

describe("normalizeResult", () => {
  it("throws RuntimeError(30) when no fenced block exists", () => {
    const stdout = JSON.stringify({ type: "text", part: { text: "no json here" } });
    expect(() => normalizeResult(stdout)).toThrow(RuntimeError);
    try {
      normalizeResult(stdout);
    } catch (err) {
      expect((err as RuntimeError).code).toBe(30);
    }
  });

  it("throws RuntimeError(30) on malformed JSON in the block", () => {
    const stdout = JSON.stringify({ type: "text", part: { text: "```json\n{ not valid \n```" } });
    expect(() => normalizeResult(stdout)).toThrow(RuntimeError);
  });

  it("throws RuntimeError(30) when the parsed object fails schema validation", () => {
    const stdout = JSON.stringify({
      type: "text",
      part: { text: '```json\n{"schema_version":1,"run_id":"r","agent":"planner","status":"success"}\n```' },
    });
    expect(() => normalizeResult(stdout)).toThrow(RuntimeError);
  });

  it("succeeds on a valid result", () => {
    const stdout = JSON.stringify({
      type: "text",
      part: {
        text: '```json\n{"schema_version":1,"run_id":"r","agent":"planner","status":"success","summary":"ok"}\n```',
      },
    });
    const { result } = normalizeResult(stdout);
    expect(result.status).toBe("success");
  });
});
