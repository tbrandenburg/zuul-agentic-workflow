# zuul-agentic-workflow

Proof of concept for orchestrating a small, Git-backed AI agent workflow with
[Zuul](https://zuul-ci.org/) in a local sandbox.

## Goal

Demonstrate that Zuul can drive a manual/API task through a
planner → coder → reviewer agent chain, gated by deterministic validation,
producing a traceable buildset with structured run summaries, logs, and a
generated patch/artifact bundle — without writing to or deploying application
repositories.

See [docs/INITIAL.md](docs/INITIAL.md) for the full PoC plan.

## Status

Early scaffolding — implementation has not started yet.

## License

TBD
