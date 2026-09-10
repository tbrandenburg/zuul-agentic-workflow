// Phase 5 (docs/PLAN.md §8 "Run API", §11 task 5.4): Fastify HTTP server
// implementing POST /runs, GET /runs/:id, GET /runs/:id/summary, GET
// /healthz. Reuses git-writer.ts's pushRun (Phase 2, R14) - never
// reimplemented here.
import Fastify, { type FastifyInstance } from "fastify";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateTaskRequest, formatErrors, type TaskRequest } from "@repo/agent-contracts";
import { pushRun } from "./git-writer.js";
import { generateUlid } from "./ulid.js";

const execFileAsync = promisify(execFile);

export interface RunApiConfig {
  /** Filesystem path to the bare `agent-runs` git repo (git-writer's target). */
  agentRunsRepoPath: string;
  /** Base URL of zuul-web's REST API, e.g. http://localhost:9000. */
  zuulUrl: string;
  tenant: string;
  pipeline: string;
  project: string;
  /** Path to a small local JSON index file (run_id -> newrev), plan §8. */
  indexPath: string;
  /**
   * Mints a fresh Zuul auth JWT. Defaults to shelling out to `docker
   * compose ... exec scheduler zuul-admin create-auth-token`, matching
   * zuul/scripts/e2e-4.sh's bash logic exactly (ported to TypeScript, not
   * re-invoking the bash script). Injectable so unit tests never need a
   * live Zuul stack.
   */
  mintToken: () => Promise<string>;
  /**
   * Invokes `zuul-client enqueue-ref`. Injectable so unit tests can assert
   * on the arguments without a live Zuul stack.
   */
  enqueueRef: (args: { oldrev: string; newrev: string }) => Promise<void>;
  /**
   * Fetches JSON from a URL (used for the zuul-web REST calls in GET
   * /runs/:id and /runs/:id/summary). Defaults to the global `fetch`;
   * injectable for tests.
   */
  fetchJson?: (url: string) => Promise<unknown>;
}

const DEFAULT_COMPOSE_ARGS = [
  "compose",
  "-p",
  "zuul-poc",
  "-f",
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../zuul/docker-compose.yaml"),
];

/** Default token minter: real `docker compose exec scheduler zuul-admin create-auth-token`. */
export async function defaultMintToken(tenant: string): Promise<string> {
  const { stdout } = await execFileAsync("docker", [
    ...DEFAULT_COMPOSE_ARGS,
    "exec",
    "-T",
    "scheduler",
    "zuul-admin",
    "create-auth-token",
    "--auth-config",
    "zuul_operator",
    "--user",
    "run-api",
    "--tenant",
    tenant,
    "--expires-in",
    "300",
  ]);
  // Output includes the literal "Bearer " prefix (plan §1.9) - strip it.
  return stdout.replace(/^Bearer\s+/, "").trim();
}

/** Default enqueue-ref invoker: real `zuul-client enqueue-ref`. */
export function makeDefaultEnqueueRef(config: {
  zuulUrl: string;
  tenant: string;
  pipeline: string;
  project: string;
  mintToken: () => Promise<string>;
}): (args: { oldrev: string; newrev: string }) => Promise<void> {
  return async ({ oldrev, newrev }) => {
    const token = await config.mintToken();
    await execFileAsync("zuul-client", [
      "--zuul-url",
      config.zuulUrl,
      "--auth-token",
      token,
      "enqueue-ref",
      "--tenant",
      config.tenant,
      "--pipeline",
      config.pipeline,
      "--project",
      config.project,
      "--ref",
      "refs/heads/agent-runs",
      "--oldrev",
      oldrev,
      "--newrev",
      newrev,
    ]);
  };
}

interface RunIndex {
  [runId: string]: { newrev: string; requestedAt: string };
}

function loadIndex(indexPath: string): RunIndex {
  if (!existsSync(indexPath)) return {};
  try {
    return JSON.parse(readFileSync(indexPath, "utf-8")) as RunIndex;
  } catch {
    return {};
  }
}

function saveIndex(indexPath: string, index: RunIndex): void {
  writeFileSync(indexPath, `${JSON.stringify(index, null, 2)}\n`, "utf-8");
}

interface BuildsetSummary {
  status: string;
  buildset_uuid: string | null;
  builds: unknown[];
  artifacts: unknown[];
}

/**
 * `GET /buildsets` (list) does NOT include per-build detail (plan §7.13's
 * table lists it separately from `/buildset/{uuid}` detail) - verified
 * empirically against a live Zuul 14.2.0 instance while implementing this
 * phase: the list response has no `builds` key at all. Resolving a run's
 * status therefore always requires two REST calls: list (to find the
 * uuid for this run's newrev) then detail (for builds/artifacts).
 */
async function resolveBuildsetSummary(
  fetchJson: (url: string) => Promise<unknown>,
  zuulUrl: string,
  tenant: string,
  newrev: string,
): Promise<BuildsetSummary> {
  const listUrl = `${zuulUrl}/api/tenant/${tenant}/buildsets?ref=refs/heads/agent-runs&newrev=${newrev}`;
  const listRaw = await fetchJson(listUrl);
  const list = Array.isArray(listRaw) ? listRaw : [];
  const first = list[0] as Record<string, unknown> | undefined;
  if (!first) {
    return { status: "PENDING", buildset_uuid: null, builds: [], artifacts: [] };
  }
  const uuid = (first.uuid as string | undefined) ?? null;
  const status = (first.result as string | null) ?? "PENDING";
  if (!uuid) {
    return { status, buildset_uuid: null, builds: [], artifacts: [] };
  }
  const detailUrl = `${zuulUrl}/api/tenant/${tenant}/buildset/${uuid}`;
  const detailRaw = await fetchJson(detailUrl);
  const detail = (detailRaw ?? {}) as Record<string, unknown>;
  const builds = Array.isArray(detail.builds) ? detail.builds : [];
  const artifacts = builds.flatMap((b) => {
    const build = b as Record<string, unknown>;
    return Array.isArray(build.artifacts) ? build.artifacts : [];
  });
  return { status, buildset_uuid: uuid, builds, artifacts };
}

export function buildServer(config: RunApiConfig): FastifyInstance {
  const fetchJson = config.fetchJson ?? (async (url: string) => (await fetch(url)).json());
  const app = Fastify({ logger: false });

  app.get("/healthz", async () => ({ status: "ok" }));

  app.post("/runs", async (request, reply) => {
    const body = request.body;
    const result = validateTaskRequest(body);
    if (!result.valid) {
      await reply.status(400).send({ error: "invalid_request", detail: formatErrors(result.errors) });
      return;
    }
    const taskRequest = result.data as TaskRequest;

    // run_id and requested_at are SERVER-assigned, never client-supplied
    // (plan §4.1) - any such fields in the body are already rejected by
    // additionalProperties:false in task-request.schema.json.
    const runId = generateUlid();
    const requestedAt = new Date().toISOString();
    const persisted = { ...taskRequest, run_id: runId, requested_at: requestedAt };

    const { oldrev, newrev } = await pushRun(config.agentRunsRepoPath, runId, persisted);

    try {
      await config.enqueueRef({ oldrev, newrev });
    } catch (err) {
      await reply.status(502).send({ error: "enqueue_failed", detail: String(err) });
      return;
    }

    const index = loadIndex(config.indexPath);
    index[runId] = { newrev, requestedAt };
    saveIndex(config.indexPath, index);

    await reply.status(202).send({
      run_id: runId,
      newrev,
      status_url: `/runs/${runId}`,
    });
  });

  app.get<{ Params: { id: string } }>("/runs/:id", async (request, reply) => {
    const index = loadIndex(config.indexPath);
    const entry = index[request.params.id];
    if (!entry) {
      await reply.status(404).send({ error: "unknown_run_id" });
      return;
    }
    const summary = await resolveBuildsetSummary(fetchJson, config.zuulUrl, config.tenant, entry.newrev);
    await reply.send(summary);
  });

  app.get<{ Params: { id: string } }>("/runs/:id/summary", async (request, reply) => {
    const index = loadIndex(config.indexPath);
    const entry = index[request.params.id];
    if (!entry) {
      await reply.status(404).send({ error: "unknown_run_id" });
      return;
    }
    const summary = await resolveBuildsetSummary(fetchJson, config.zuulUrl, config.tenant, entry.newrev);
    const publishBuild = (summary.builds as Array<Record<string, unknown>>).find(
      (b) => b.job_name === "publish-run-summary",
    );
    const logUrl = publishBuild?.log_url as string | undefined;
    if (!logUrl) {
      await reply.status(404).send({ error: "summary_not_ready", detail: "publish-run-summary has no log_url yet" });
      return;
    }
    const summaryJson = await fetchJson(`${logUrl.replace(/\/$/, "")}/artifacts/summary/run-summary.json`);
    await reply.send(summaryJson);
  });

  return app;
}

export async function startServer(overrides: Partial<RunApiConfig> = {}): Promise<FastifyInstance> {
  const tenant = overrides.tenant ?? "agents";
  const zuulUrl = overrides.zuulUrl ?? "http://localhost:9000";
  const mintToken = overrides.mintToken ?? (() => defaultMintToken(tenant));
  const config: RunApiConfig = {
    agentRunsRepoPath:
      overrides.agentRunsRepoPath ??
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../zuul/gitserver-repos/agent-runs.git"),
    zuulUrl,
    tenant,
    pipeline: overrides.pipeline ?? "agent-run",
    project: overrides.project ?? "agent-runs",
    indexPath: overrides.indexPath ?? path.resolve(process.cwd(), "run-api-index.json"),
    mintToken,
    enqueueRef:
      overrides.enqueueRef ??
      makeDefaultEnqueueRef({ zuulUrl, tenant, pipeline: "agent-run", project: "agent-runs", mintToken }),
    fetchJson: overrides.fetchJson,
  };
  const app = buildServer(config);
  const port = Number(process.env.RUN_API_PORT ?? 4100);
  await app.listen({ port, host: "0.0.0.0" });
  return app;
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  startServer().catch((err: unknown) => {
    process.stderr.write(`run-api failed to start: ${String(err)}\n`);
    process.exit(1);
  });
}
