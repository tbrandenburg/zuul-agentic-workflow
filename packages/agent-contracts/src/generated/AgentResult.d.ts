/* eslint-disable */
/**
 * Auto-generated from agent-result.schema.json. Do not edit by hand.
 */

export interface AgentResult {
  schema_version: 1;
  run_id: string;
  agent: "planner" | "coder" | "reviewer";
  status: "success" | "failure" | "error";
  summary: string;
  claims?: {
    statement: string;
    verifiable: boolean;
    evidence?: string;
  }[];
  files?: string[];
  next_actions?: string[];
  confidence?: number;
  state_uri?: string;
  telemetry?: {
    model?: string;
    attempts?: number;
    duration_ms?: number;
    tokens_input?: number;
    tokens_output?: number;
    cost?: number;
  };
}
