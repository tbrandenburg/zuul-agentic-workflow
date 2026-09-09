# @repo/agent-contracts

Single source of truth for the four PoC JSON Schemas (draft 2020-12),
validated with Ajv (`ajv/dist/2020` entry point).

## Layout

- `schemas/*.json` — hand-authored schemas, copied verbatim from
  `docs/PLAN.md` §4 (task-request, agent-input, agent-result) plus a
  designed `run-summary` schema (§4.4 only describes it in prose).
- `src/generated/*.d.ts` — TypeScript types generated from the schemas via
  `json-schema-to-typescript`. **Do not hand-edit** — regenerate with
  `npm run generate-types`. Checked into git so editors/type-checking work
  without a build step, but always regenerated as part of `npm run build`
  so drift is impossible to ship silently.
- `src/index.ts` — Ajv-compiled validators, one per schema, exposed as both
  a generic `validate(schemaName, data)` and named helpers
  (`validateTaskRequest`, `validateAgentInput`, `validateAgentResult`,
  `validateRunSummary`).

## Regenerating types after a schema change

```bash
npm run generate-types --workspace @repo/agent-contracts
```

## Root-level `schemas/` symlink

The repo root's `schemas/` directory is a symlink to
`packages/agent-contracts/schemas` (per `docs/PLAN.md` §3, "DRY over layout
fidelity") so Ansible playbooks and other non-Node tooling can reference
schemas without a package manager.
