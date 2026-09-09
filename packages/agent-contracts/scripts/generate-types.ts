// Generates TypeScript type declarations from the JSON Schema contracts.
// Run via `npm run generate-types` (also wired into `npm run build`).
// Output is checked into src/generated/*.d.ts for editor/type-check use
// without requiring a build step first.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { compile } from "json-schema-to-typescript";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const schemasDir = path.join(here, "..", "schemas");
const outDir = path.join(here, "..", "src", "generated");

const schemas: Array<{ file: string; typeName: string }> = [
  { file: "task-request.schema.json", typeName: "TaskRequest" },
  { file: "agent-input.schema.json", typeName: "AgentInput" },
  { file: "agent-result.schema.json", typeName: "AgentResult" },
  { file: "run-summary.schema.json", typeName: "RunSummary" },
];

async function main(): Promise<void> {
  await mkdir(outDir, { recursive: true });
  for (const { file, typeName } of schemas) {
    const raw = await readFile(path.join(schemasDir, file), "utf-8");
    const schema: unknown = JSON.parse(raw);
    const ts = await compile(schema as Parameters<typeof compile>[0], typeName, {
      bannerComment: `/* eslint-disable */\n/**\n * Auto-generated from ${file}. Do not edit by hand.\n */`,
      additionalProperties: false,
    });
    const outFile = path.join(outDir, `${typeName}.d.ts`);
    await writeFile(outFile, ts, "utf-8");
    console.log(`generated ${outFile}`);
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
