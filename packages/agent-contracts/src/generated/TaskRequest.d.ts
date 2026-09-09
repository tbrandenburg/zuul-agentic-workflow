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
}
