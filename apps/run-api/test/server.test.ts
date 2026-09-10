import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { buildServer, type RunApiConfig } from "../src/server.js";

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

const cleanupDirs: string[] = [];
afterEach(() => {
  while (cleanupDirs.length > 0) {
    const d = cleanupDirs.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  }
});

function makeBareRepo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "run-api-bare-"));
  git(["init", "--bare", "-q"], dir);
  cleanupDirs.push(dir);
  return dir;
}

function makeConfig(overrides: Partial<RunApiConfig> = {}): RunApiConfig {
  const bareRepo = makeBareRepo();
  const indexDir = mkdtempSync(path.join(tmpdir(), "run-api-index-"));
  cleanupDirs.push(indexDir);
  return {
    agentRunsRepoPath: bareRepo,
    zuulUrl: "http://localhost:9000",
    tenant: "agents",
    pipeline: "agent-run",
    project: "agent-runs",
    indexPath: path.join(indexDir, "index.json"),
    mintToken: async () => "test-token",
    enqueueRef: async () => {
      /* no-op stub - never invokes a live Zuul stack */
    },
    ...overrides,
  };
}

const VALID_BODY = {
  task: "Add a comment above line 3 of foo.txt",
  repo: "sandbox/services/example",
  base_ref: "main",
};

describe("POST /runs — request validation (no live Zuul stack)", () => {
  it("rejects a body missing required fields with 400", async () => {
    const app = buildServer(makeConfig());
    const res = await app.inject({ method: "POST", url: "/runs", payload: { task: "too short task" } });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body) as { error: string };
    expect(body.error).toBe("invalid_request");
  });

  it("rejects a body with an unknown additional property", async () => {
    const app = buildServer(makeConfig());
    const res = await app.inject({
      method: "POST",
      url: "/runs",
      payload: { ...VALID_BODY, run_id: "client-supplied" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects a task string shorter than minLength", async () => {
    const app = buildServer(makeConfig());
    const res = await app.inject({ method: "POST", url: "/runs", payload: { ...VALID_BODY, task: "short" } });
    expect(res.statusCode).toBe(400);
  });

  it("accepts a valid body, assigns a ULID run_id, pushes to git, and calls enqueueRef", async () => {
    let enqueueArgs: { oldrev: string; newrev: string } | undefined;
    const app = buildServer(
      makeConfig({
        enqueueRef: async (args) => {
          enqueueArgs = args;
        },
      }),
    );
    const res = await app.inject({ method: "POST", url: "/runs", payload: VALID_BODY });
    expect(res.statusCode).toBe(202);
    const body = JSON.parse(res.body) as { run_id: string; newrev: string; status_url: string };
    expect(body.run_id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(body.newrev).toMatch(/^[0-9a-f]{40}$/);
    expect(body.status_url).toBe(`/runs/${body.run_id}`);
    expect(enqueueArgs?.newrev).toBe(body.newrev);
    expect(enqueueArgs?.oldrev).toBeTruthy();
    expect(enqueueArgs?.oldrev).not.toBe(enqueueArgs?.newrev);
  });

  it("never returns run_id or requested_at as client-suppliable — server-assigned only", async () => {
    const app = buildServer(makeConfig());
    const res = await app.inject({
      method: "POST",
      url: "/runs",
      payload: { ...VALID_BODY, requested_at: "2000-01-01T00:00:00Z" },
    });
    // requested_at is not a schema property either - additionalProperties:false rejects it.
    expect(res.statusCode).toBe(400);
  });

  it("returns 502 and does not crash when enqueueRef fails", async () => {
    const app = buildServer(
      makeConfig({
        enqueueRef: async () => {
          throw new Error("zuul-client boom");
        },
      }),
    );
    const res = await app.inject({ method: "POST", url: "/runs", payload: VALID_BODY });
    expect(res.statusCode).toBe(502);
  });
});

describe("GET /runs/:id and /runs/:id/summary — index + REST mapping (stubbed Zuul REST calls)", () => {
  it("returns 404 for an unknown run_id", async () => {
    const app = buildServer(makeConfig());
    const res = await app.inject({ method: "GET", url: "/runs/01ARZ3NDEKTSV4RRFFQ69G5FAV" });
    expect(res.statusCode).toBe(404);
  });

  it("resolves a known run_id to its newrev and maps the stubbed buildsets response (list + detail, matching live Zuul's REST shape)", async () => {
    const fetchedUrls: string[] = [];
    const config = makeConfig({
      fetchJson: async (url: string) => {
        fetchedUrls.push(url);
        if (url.includes("/buildsets?")) {
          return [{ uuid: "buildset-uuid-1", result: "SUCCESS" }];
        }
        return {
          uuid: "buildset-uuid-1",
          result: "SUCCESS",
          builds: [{ job_name: "planner-agent", result: "SUCCESS" }],
        };
      },
    });
    const app = buildServer(config);
    const postRes = await app.inject({ method: "POST", url: "/runs", payload: VALID_BODY });
    const { run_id: runId, newrev } = JSON.parse(postRes.body) as { run_id: string; newrev: string };

    const getRes = await app.inject({ method: "GET", url: `/runs/${runId}` });
    expect(getRes.statusCode).toBe(200);
    const body = JSON.parse(getRes.body) as { status: string; buildset_uuid: string; builds: unknown[] };
    expect(body.status).toBe("SUCCESS");
    expect(body.buildset_uuid).toBe("buildset-uuid-1");
    expect(body.builds).toHaveLength(1);
    expect(fetchedUrls[0]).toContain(newrev);
    expect(fetchedUrls[0]).toContain("ref=refs/heads/agent-runs");
    expect(fetchedUrls[1]).toContain("buildset-uuid-1");
  });

  it("reports PENDING when the buildsets query returns an empty array", async () => {
    const config = makeConfig({ fetchJson: async () => [] });
    const app = buildServer(config);
    const postRes = await app.inject({ method: "POST", url: "/runs", payload: VALID_BODY });
    const { run_id: runId } = JSON.parse(postRes.body) as { run_id: string };

    const getRes = await app.inject({ method: "GET", url: `/runs/${runId}` });
    const body = JSON.parse(getRes.body) as { status: string };
    expect(body.status).toBe("PENDING");
  });

  it("GET /runs/:id/summary proxies run-summary.json once publish-run-summary has a log_url", async () => {
    const summaryPayload = { schema_version: 1, run_id: "x", final_verdict: "success" };
    const config = makeConfig({
      fetchJson: async (url: string) => {
        if (url.includes("/buildsets?")) {
          return [{ uuid: "buildset-uuid-2", result: "SUCCESS" }];
        }
        if (url.includes("/buildset/")) {
          return {
            uuid: "buildset-uuid-2",
            result: "SUCCESS",
            builds: [
              { job_name: "publish-run-summary", result: "SUCCESS", log_url: "http://localhost:8000/some-build/" },
            ],
          };
        }
        return summaryPayload;
      },
    });
    const app = buildServer(config);
    const postRes = await app.inject({ method: "POST", url: "/runs", payload: VALID_BODY });
    const { run_id: runId } = JSON.parse(postRes.body) as { run_id: string };

    const res = await app.inject({ method: "GET", url: `/runs/${runId}/summary` });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual(summaryPayload);
  });

  it("GET /runs/:id/summary returns 404 when publish-run-summary has not produced a log_url yet", async () => {
    const config = makeConfig({
      fetchJson: async (url: string) => {
        if (url.includes("/buildsets?")) {
          return [{ uuid: "buildset-uuid-3", result: null }];
        }
        return { uuid: "buildset-uuid-3", result: null, builds: [] };
      },
    });
    const app = buildServer(config);
    const postRes = await app.inject({ method: "POST", url: "/runs", payload: VALID_BODY });
    const { run_id: runId } = JSON.parse(postRes.body) as { run_id: string };

    const res = await app.inject({ method: "GET", url: `/runs/${runId}/summary` });
    expect(res.statusCode).toBe(404);
  });
});

describe("GET /healthz", () => {
  it("returns 200 ok", async () => {
    const app = buildServer(makeConfig());
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ status: "ok" });
  });
});
