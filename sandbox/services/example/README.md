# sandbox/services/example

Tiny target service used as the "repo the coder agent patches" (docs/PLAN.md
§3, §11 Phase 4). Deliberately minimal: two files (`index.js`, `lib/math.js`),
a handful of `node --test` tests, and a package-local ESLint flat config.

- `npm run lint` — eslint over the whole directory.
- `npm test` — `node --test test/`.

## `base_sha` (patch pinning)

Phase 4's coder always patches this repo against a **pinned** commit SHA, not
a moving branch tip. Rather than hardcoding a SHA here (which would go stale
the moment this file's own commit lands), the SHA is resolved **dynamically,
per run**, by the Zuul initializer: `git -C /repo rev-parse <base_ref>`
against the trusted `/repo` bind mount (see
`zuul/zuul-config/playbooks/init-run.yaml`). `base_ref` is whatever branch the
run request names (e.g. `main`, or the current feature branch for local
testing) — the resulting SHA is what flows into `agent-input.json`'s
`task.base_sha` and what `agent-tools validate`'s check 3 applies the patch
against.
