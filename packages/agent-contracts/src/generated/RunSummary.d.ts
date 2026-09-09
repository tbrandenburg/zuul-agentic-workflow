/* eslint-disable */
/**
 * Auto-generated from run-summary.schema.json. Do not edit by hand.
 */

export interface RunSummary {
  schema_version: 1;
  run_id: string;
  request: {
    task: string;
    repo: string;
    base_ref: string;
    model?: string;
  };
  results: {
    role: "planner" | "coder" | "reviewer" | "validation";
    status: "success" | "failure" | "error" | "skipped";
    summary: string;
    artifact_url?: string;
    build_url?: string;
  }[];
  validation_report?: {} | null;
  buildset_uuid: string;
  build_urls?: string[];
  artifact_urls?: string[];
  final_verdict: "success" | "failure" | "error";
  totals: {
    cost: number;
    tokens_input: number;
    tokens_output: number;
  };
}
