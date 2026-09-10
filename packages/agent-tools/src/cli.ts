#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { runValidation } from "./validate.js";
import { toMarkdown } from "./summary.js";

interface CliArgs {
  patch: string;
  result: string;
  request?: string;
  repoRoot: string;
  serviceDir: string;
  baseSha: string;
  reportJson: string;
  reportMd: string;
}

function parseCliArgs(argv: string[]): CliArgs {
  const get = (flag: string): string | undefined => {
    const idx = argv.indexOf(flag);
    return idx >= 0 ? argv[idx + 1] : undefined;
  };
  const required = (flag: string): string => {
    const v = get(flag);
    if (!v) throw new Error(`missing required ${flag}`);
    return v;
  };
  return {
    patch: required("--patch"),
    result: required("--result"),
    request: get("--request"),
    repoRoot: required("--repo-root"),
    serviceDir: required("--service-dir"),
    baseSha: required("--base-sha"),
    reportJson: required("--report-json"),
    reportMd: required("--report-md"),
  };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv[0] !== "validate") {
    throw new Error(`unsupported subcommand '${argv[0] ?? ""}' (expected 'validate')`);
  }
  const args = parseCliArgs(argv.slice(1));
  const { checks, passed } = runValidation({
    patchPath: args.patch,
    resultPath: args.result,
    requestPath: args.request,
    repoRoot: args.repoRoot,
    serviceDir: args.serviceDir,
    baseSha: args.baseSha,
  });
  const report = { schema_version: 1 as const, passed, checks };

  mkdirSync(path.dirname(args.reportJson), { recursive: true });
  mkdirSync(path.dirname(args.reportMd), { recursive: true });
  writeFileSync(args.reportJson, `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(args.reportMd, toMarkdown(report));

  for (const c of checks) {
    console.error(`[agent-tools] ${c.status.padEnd(4)} ${c.name}: ${c.message}`);
  }
  console.error(`[agent-tools] overall: ${passed ? "PASSED" : "FAILED"}`);
  process.exitCode = passed ? 0 : 1;
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exitCode = 1;
});
