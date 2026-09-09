import { agentResultSchemaJson, type AgentInput } from "@repo/agent-contracts";

/**
 * Composes the full prompt sent to `opencode run`: role template + task +
 * upstream summaries + validation report + a strict output-contract
 * instruction embedding the actual agent-result.schema.json (plan §5.3
 * step 2).
 */
export function composePrompt(template: string, input: AgentInput): string {
  const upstream = renderUpstream(input.upstream_results ?? []);
  const validation = renderValidation(input.validation);
  const schemaJson = JSON.stringify(agentResultSchemaJson(), null, 2);

  return [
    template.trim(),
    "",
    "## Task",
    `Description: ${input.task.description}`,
    `Repository: ${input.task.repo}`,
    `Base ref: ${input.task.base_ref}`,
    input.task.base_sha ? `Base sha: ${input.task.base_sha}` : "",
    "",
    "## Upstream results",
    upstream,
    "",
    "## Validation report",
    validation,
    "",
    "## Output contract",
    "Emit a single fenced ```json code block matching exactly this JSON Schema " +
      "(draft 2020-12). Do not emit any other fenced json blocks. " +
      "Any prose outside the block is ignored.",
    "```json",
    schemaJson,
    "```",
  ]
    .filter((line) => line !== undefined)
    .join("\n");
}

function renderUpstream(results: AgentInput["upstream_results"]): string {
  if (!results || results.length === 0) return "(none)";
  return results
    .map(
      (r: NonNullable<AgentInput["upstream_results"]>[number]) =>
        `- [${r.role}] status=${r.status ?? "unknown"}: ${r.summary}`,
    )
    .join("\n");
}

function renderValidation(validation: AgentInput["validation"]): string {
  if (!validation) return "(none)";
  return JSON.stringify(validation, null, 2);
}
