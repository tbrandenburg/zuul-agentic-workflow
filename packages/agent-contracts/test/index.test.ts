import { describe, it, expect } from "vitest";
import { validateTaskRequest, validateAgentInput, validateAgentResult, validateRunSummary } from "../src/index.js";

describe("agent-contracts validators", () => {
  it("accepts a valid task-request", () => {
    const result = validateTaskRequest({
      task: "Say hello in one sentence.",
      repo: "agent-runs",
      base_ref: "main",
    });
    expect(result.valid).toBe(true);
  });

  it("rejects a task-request missing required fields", () => {
    const result = validateTaskRequest({ task: "x" });
    expect(result.valid).toBe(false);
    expect(result.errors).not.toBeNull();
  });

  it("accepts a valid agent-input", () => {
    const result = validateAgentInput({
      schema_version: 1,
      run_id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      role: "planner",
      task: { description: "do the thing", repo: "agent-runs", base_ref: "main" },
      workspace: { path: "/tmp/ws", mode: "read-only" },
      model: "opencode/big-pickle",
    });
    expect(result.valid).toBe(true);
  });

  it("accepts a valid agent-result", () => {
    const result = validateAgentResult({
      schema_version: 1,
      run_id: "r1",
      agent: "planner",
      status: "success",
      summary: "did the thing",
    });
    expect(result.valid).toBe(true);
  });

  it("rejects an agent-result missing summary", () => {
    const result = validateAgentResult({
      schema_version: 1,
      run_id: "r1",
      agent: "planner",
      status: "success",
    });
    expect(result.valid).toBe(false);
  });

  it("accepts a valid run-summary", () => {
    const result = validateRunSummary({
      schema_version: 1,
      run_id: "r1",
      request: { task: "t", repo: "agent-runs", base_ref: "main" },
      results: [],
      buildset_uuid: "uuid-1",
      final_verdict: "success",
      totals: { cost: 0, tokens_input: 0, tokens_output: 0 },
    });
    expect(result.valid).toBe(true);
  });
});
