# Zuul Phase 0 infrastructure spike

Implements `docs/PLAN.md` §11 Phase 0. A minimal, pinned (14.2.0) Zuul stack
proving:

- a single `git` driver connection can host both a config-project
  (`zuul-config`) and an untrusted-project (`agent-runs`);
- `zuul-client enqueue-ref` with real, non-zero `oldrev`/`newrev` produces a
  buildset;
- an executor-only job (no `nodeset`, no launcher, no node) runs to SUCCESS.

No Gerrit anywhere. No launcher/node in this phase (introduced in Phase 4).

## Layout

| Path | Purpose |
|---|---|
| `docker-compose.yaml` | zk, mysql, scheduler, web, executor, logs, gitserver, certs-init |
| `etc_zuul/` | `zuul.conf`, `main.yaml` (tenant), `zoo.cfg`, cert-wait helper |
| `zuul-config/` | Config-project source (pipeline + jobs), pushed to the bare repo by `scripts/seed-repos.sh` |
| `gitserver-image/` | Minimal Alpine `git daemon` (with `receive-pack`) serving `git://gitserver/<repo>` |
| `gitserver-repos/` | Generated bare repos (`zuul-config.git`, `agent-runs.git`) — gitignored, always reproducible |
| `logs-image/` | Apache log server (copied verbatim from the upstream Zuul example) |
| `tools/` | `zk-ca.sh` + `openssl.cnf` (copied verbatim from the upstream Zuul 14.2.0 sdist) |
| `scripts/seed-repos.sh` | Idempotently (re)creates the bare repos and pushes `zuul-config` content |
| `scripts/e2e-0.sh` | Gate E2E-0: push a run commit, enqueue-ref, poll for buildset SUCCESS |

## Quickstart

```bash
make phase0-up      # docker compose up (pulls/builds images, generates ZK TLS certs)
make phase0-seed     # seed the bare repos served by gitserver
make phase0-e2e-0    # gate: enqueue-ref -> buildset -> executor-only job SUCCESS
```

Web UI: http://localhost:9000/t/agents/buildsets (anonymous read, no login).

## Known Phase-0-only limitations (intentionally deferred)

- `[auth zuul_operator] secret=` is a short PoC placeholder, not
  production-grade. Revisit before any non-local deployment.
- No log volume wiring yet (`zuul.log_url` / artifacts) — Phase 1 task 1.2.
- No `agent-runner` node/launcher — Phase 4.
- `agent-smoke` job is a throwaway smoke-test job; Phase 1 replaces it with
  `initialize-agent-run` (`type: initializer`).

## Troubleshooting notes (found the hard way)

- Alpine's `git` package does **not** include `git daemon` — install the
  separate `git-daemon` package.
- `git daemon` running as root refuses to serve repos owned by another UID
  ("dubious ownership") — add `git config --system --add safe.directory '*'`
  in the image.
- Even executor-only (no-`nodeset`) jobs need `[executor] private_key_file`
  set to a real, `chmod 600` private key, or the executor's SSH-agent setup
  fails before the job ever runs.
- Do **not** name a custom job `noop` — Zuul has a reserved built-in job of
  that exact name and defining your own causes an obscure internal
  `KeyError`/`AttributeError` in the tenant parser instead of a clear
  "duplicate job" error.
- ZooKeeper TLS is mandatory in Zuul 14 (no plaintext fallback) — use the
  upstream `tools/zk-ca.sh` self-signed CA script rather than reinventing it.
- **Never delete-and-recreate a bind-mounted host directory while its
  container is running.** Linux bind mounts pin the inode, not the path; if
  you `rm -rf` and `mkdir` the host side afterward, the container keeps
  serving the old (unlinked) directory and silently shows it as empty.
  Recreate the container (`docker compose up -d --force-recreate <service>`)
  after any such host-side directory replacement, or better, never replace
  the directory once a container has mounted it — only edit its contents in
  place (`scripts/seed-repos.sh` and `make phase0-up`'s `mkdir -p` follow this
  rule).

