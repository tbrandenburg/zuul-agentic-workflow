#!/usr/bin/env node
import { parseArgs } from "node:util";
import path from "node:path";
import { loadAgentInputSafe, buildInvocation, executeRun } from "./run.js";

interface CliArgs {
  role: string;
  input: string;
  output: string;
  prompt: string;
  model: string;
  mock: boolean;
  mockFixture: string;
  workspace?: string;
  artifacts?: string;
}

function parseCliArgs(argv: string[]): CliArgs {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      role: { type: "string" },
      input: { type: "string" },
      output: { type: "string" },
      prompt: { type: "string" },
      model: { type: "string" },
      mock: { type: "boolean", default: false },
      "mock-fixture": { type: "string", default: "valid" },
      workspace: { type: "string" },
      artifacts: { type: "string" },
    },
  });

  if (positionals[0] !== "run") {
    throw new Error(`unsupported subcommand '${positionals[0] ?? ""}' (expected 'run')`);
  }
  for (const required of ["role", "input", "output", "prompt", "model"] as const) {
    if (typeof values[required] !== "string") {
      throw new Error(`missing required --${required}`);
    }
  }

  return {
    role: values.role as string,
    input: path.resolve(values.input as string),
    output: path.resolve(values.output as string),
    prompt: path.resolve(values.prompt as string),
    model: values.model as string,
    mock: values.mock === true,
    mockFixture: values["mock-fixture"] as string,
    workspace: values.workspace ? path.resolve(values.workspace) : undefined,
    artifacts: values.artifacts ? path.resolve(values.artifacts) : undefined,
  };
}

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2));
  const code = await executeRun(args);
  process.exitCode = code;
}

// buildInvocation/loadAgentInputSafe re-exported for potential reuse/testing.
export { buildInvocation, loadAgentInputSafe };

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
