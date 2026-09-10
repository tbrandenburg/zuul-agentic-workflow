import { Ajv2020 } from "ajv/dist/2020.js";
import type { ValidateFunction, ErrorObject, Options as AjvOptions } from "ajv";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { TaskRequest } from "./generated/TaskRequest.js";
import type { AgentInput } from "./generated/AgentInput.js";
import type { AgentResult } from "./generated/AgentResult.js";
import type { RunSummary } from "./generated/RunSummary.js";

export type { TaskRequest, AgentInput, AgentResult, RunSummary };
export { SECRET_PATTERNS } from "./secret-patterns.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const schemasDir = path.join(here, "..", "schemas");

function loadSchema(file: string): unknown {
  return JSON.parse(readFileSync(path.join(schemasDir, file), "utf-8"));
}

const require = createRequire(import.meta.url);
// ajv-formats ships as a dual CJS module with no NodeNext-friendly ESM
// default export shape; load it via createRequire rather than fighting
// TypeScript's interop inference.
const addFormats = require("ajv-formats") as (ajv: Ajv2020) => void;

const ajv = new Ajv2020({ allErrors: true, useDefaults: true, strict: true } satisfies AjvOptions);
addFormats(ajv);

const validators = {
  "task-request": ajv.compile(loadSchema("task-request.schema.json") as object),
  "agent-input": ajv.compile(loadSchema("agent-input.schema.json") as object),
  "agent-result": ajv.compile(loadSchema("agent-result.schema.json") as object),
  "run-summary": ajv.compile(loadSchema("run-summary.schema.json") as object),
} satisfies Record<string, ValidateFunction>;

export type SchemaName = keyof typeof validators;

export interface ValidationResult<T> {
  valid: boolean;
  data: T | null;
  errors: ErrorObject[] | null;
}

/**
 * Validates `data` (mutated in place to fill schema defaults, per Ajv's
 * `useDefaults` behaviour) against the named contract schema.
 */
export function validate<T = unknown>(schemaName: SchemaName, data: unknown): ValidationResult<T> {
  const validator = validators[schemaName];
  const valid = validator(data);
  if (valid) {
    return { valid: true, data: data as T, errors: null };
  }
  return { valid: false, data: null, errors: validator.errors ?? null };
}

export function validateTaskRequest(data: unknown): ValidationResult<TaskRequest> {
  return validate<TaskRequest>("task-request", data);
}

export function validateAgentInput(data: unknown): ValidationResult<AgentInput> {
  return validate<AgentInput>("agent-input", data);
}

export function validateAgentResult(data: unknown): ValidationResult<AgentResult> {
  return validate<AgentResult>("agent-result", data);
}

export function validateRunSummary(data: unknown): ValidationResult<RunSummary> {
  return validate<RunSummary>("run-summary", data);
}

export function formatErrors(errors: ErrorObject[] | null): string {
  if (!errors || errors.length === 0) return "unknown validation error";
  return errors.map((e) => `${e.instancePath || "/"} ${e.message ?? ""}`.trim()).join("; ");
}

export function agentResultSchemaJson(): unknown {
  return loadSchema("agent-result.schema.json");
}
