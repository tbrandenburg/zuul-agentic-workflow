/* eslint-disable */
/**
 * Auto-generated from agent-input.schema.json. Do not edit by hand.
 */

export interface AgentInput {
  schema_version: 1;
  run_id: string;
  role: "planner" | "coder" | "reviewer";
  task: {
    description: string;
    repo: string;
    base_ref: string;
    base_sha?: string;
  };
  upstream_results?: {
    role: "planner" | "coder" | "reviewer" | "validation";
    summary: string;
    artifact_url?: string;
    status?: "success" | "failure" | "error";
  }[];
  validation?: {} | null;
  workspace: {
    path: string;
    mode: "read-only" | "read-write";
  };
  model: string;
  limits?: {
    timeout_ms?: number;
    max_output_bytes?: number;
    max_attempts?: number;
  };
}
