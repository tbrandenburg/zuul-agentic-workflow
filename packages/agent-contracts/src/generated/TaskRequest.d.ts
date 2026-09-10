/* eslint-disable */
/**
 * Auto-generated from task-request.schema.json. Do not edit by hand.
 */

export interface TaskRequest {
  task: string;
  repo: string;
  base_ref: string;
  model?: string;
  /**
   * @maxItems 64
   */
  allowed_paths?: string[];
  /**
   * Phase 5: opt-in, zero-cost dry-run switch (docs/PLAN.md Phase 3 cost-coupling fix). When true, agent-runtime invocations for this run use --mock instead of a real model call. Read by init-run.yaml into agent_result_initialize.mock; NOT threaded into agent-input.schema.json (that manifest has no notion of mock mode - agent-runtime is simply invoked with --mock or not).
   */
  mock?: boolean;
}
