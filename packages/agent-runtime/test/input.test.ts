import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadAgentInput, loadPromptTemplate } from "../src/input.js";
import { RuntimeError } from "../src/types.js";

describe("loadAgentInput", () => {
  it("throws RuntimeError(10) when the file does not exist", () => {
    expect(() => loadAgentInput("/nonexistent/path/agent-input.json")).toThrow(RuntimeError);
    try {
      loadAgentInput("/nonexistent/path/agent-input.json");
    } catch (err) {
      expect((err as RuntimeError).code).toBe(10);
    }
  });

  it("throws RuntimeError(10) on invalid JSON", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "agent-input-"));
    const file = path.join(dir, "agent-input.json");
    writeFileSync(file, "{ not json");
    try {
      expect(() => loadAgentInput(file)).toThrow(RuntimeError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("throws RuntimeError(10) when the manifest fails schema validation", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "agent-input-"));
    const file = path.join(dir, "agent-input.json");
    writeFileSync(file, JSON.stringify({ schema_version: 1 })); // missing required fields
    try {
      expect(() => loadAgentInput(file)).toThrow(RuntimeError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("accepts a valid manifest", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "agent-input-"));
    const file = path.join(dir, "agent-input.json");
    writeFileSync(
      file,
      JSON.stringify({
        schema_version: 1,
        run_id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
        role: "planner",
        task: { description: "do a thing", repo: "agent-runs", base_ref: "main" },
        workspace: { path: dir, mode: "read-only" },
        model: "opencode/big-pickle",
      }),
    );
    try {
      const input = loadAgentInput(file);
      expect(input.role).toBe("planner");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("loadPromptTemplate", () => {
  it("throws RuntimeError(11) when the prompt file is unreadable", () => {
    expect(() => loadPromptTemplate("/nonexistent/prompts/planner.md")).toThrow(RuntimeError);
    try {
      loadPromptTemplate("/nonexistent/prompts/planner.md");
    } catch (err) {
      expect((err as RuntimeError).code).toBe(11);
    }
  });

  it("returns the file contents when readable", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "prompt-"));
    const file = path.join(dir, "planner.md");
    writeFileSync(file, "# Role: Planner\n");
    try {
      expect(loadPromptTemplate(file)).toContain("Role: Planner");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
