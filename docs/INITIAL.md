PoC goal

Prove that Zuul can orchestrate a small, Git-backed agent workflow in a local sandbox:

manual/API task → planner → coder → reviewer → deterministic validation → result artifacts

The initial workflow will not write to application repositories or deploy. Its final output is a structured run summary, logs, and generated patch/artifact bundle.

The agent runtime is a Node.js wrapper around:

opencode run 'Hello' --model 'opencode/big-pickle'

The model name is configuration, not hardcoded into job definitions.

Key design decision: make each API task a Git change

Zuul fundamentally schedules changes. For a manual/API PoC, add a thin Run API that converts an incoming task into a small, immutable Git-backed run request:

{
  "run_id": "01...",
  "task": "Add a health-check endpoint",
  "repo": "services/example",
  "base_ref": "main",
  "model": "opencode/big-pickle",
  "requested_at": "..."
}

The API creates a change in a dedicated agent-runs repository, then enqueues it into the local Zuul pipeline. That gives each run a stable revision, audit trail, and a native Zuul buildset without prematurely granting agents write access to the target monorepo.

Monorepo layout

repo/
├── apps/
│   └── run-api/                    # accepts tasks, creates/enqueues run requests
├── packages/
│   ├── agent-runtime/              # Node runner and role adapters
│   ├── agent-contracts/            # JSON schemas/types for inputs and outputs
│   └── agent-tools/                # deterministic helpers: patch, lint, validate
├── prompts/
│   ├── planner.md
│   ├── coder.md
│   └── reviewer.md
├── zuul/
│   ├── tenant.yaml
│   ├── zuul.yaml
│   ├── jobs/
│   │   └── agent-jobs.yaml
│   ├── playbooks/
│   │   ├── init-run.yaml
│   │   ├── run-agent.yaml
│   │   └── validate-result.yaml
│   └── docker-compose.yaml          # local Zuul, executor, ZooKeeper, launcher
├── schemas/
│   ├── task-request.schema.json
│   ├── agent-input.schema.json
│   └── agent-result.schema.json
└── docs/
    └── poc.md

Keep the Zuul integration intentionally thin: Ansible prepares the workspace and invokes the Node runtime; it does not contain agent logic.

Agent graph

flowchart TD
    I["initialize-agent-run"] --> P["planner-agent"]
    P --> C["coder-agent"]
    C --> V["tool-validation"]
    V --> R["reviewer-agent"]
    R --> A["result artifacts"]

The first PoC uses the selected minimal chain: planner → coder → review. Add fan-out or zuul.child_jobs only after this path is reliable.

Job model

Define one abstract job and specialize it by role.

- job:
    name: agent
    abstract: true
    timeout: 1800
    run: zuul/playbooks/run-agent.yaml
    nodeset:
      nodes:
        - name: agent
          label: agent-runner
    vars:
      agent_output_path: /tmp/agent-result.json
- job:
    name: initialize-agent-run
    type: initializer
    run: zuul/playbooks/init-run.yaml
- job:
    name: planner-agent
    parent: agent
    vars:
      agent_role: planner
      prompt_file: prompts/planner.md
- job:
    name: coder-agent
    parent: agent
    vars:
      agent_role: coder
      prompt_file: prompts/coder.md
- job:
    name: reviewer-agent
    parent: agent
    vars:
      agent_role: reviewer
      prompt_file: prompts/reviewer.md
- job:
    name: tool-validation
    run: zuul/playbooks/validate-result.yaml
- project:
    agent-runs:
      jobs:
        - planner-agent
        - coder-agent:
            dependencies:
              - planner-agent
        - tool-validation:
            dependencies:
              - coder-agent
        - reviewer-agent:
            dependencies:
              - tool-validation

State contract

Every role receives a compact manifest, not raw chat history:

{
  "run_id": "01...",
  "task": {"description": "...", "repo": "...", "base_ref": "main"},
  "upstream_results": [
    {"role": "planner", "artifact_uri": "...", "summary": "..."}
  ],
  "workspace": {"path": "/workspace", "mode": "read-write"},
  "model": "opencode/big-pickle"
}

Every role emits the same validated result shape:

{
  "schema_version": 1,
  "run_id": "01...",
  "agent": "coder",
  "status": "success",
  "summary": "Implemented the health-check endpoint.",
  "claims": [],
  "files": ["artifacts/patch.diff"],
  "next_actions": ["Run integration tests"],
  "confidence": 0.82,
  "state_uri": "artifact://agent-result.json"
}

The Node runner writes result.json; the Zuul playbook:

1. validates it against the JSON schema;
2. returns a small summary through zuul_return;
3. publishes the full result, prompt metadata, logs, and patch as artifacts.

Dependent jobs use only the returned summary plus artifact references. This keeps Zuul variables small and makes artifact storage the durable state layer.

Node agent runtime

packages/agent-runtime should expose one stable command:

agent-runtime run \
  --role planner \
  --input /tmp/agent-input.json \
  --output /tmp/agent-result.json \
  --prompt prompts/planner.md \
  --model "${AGENT_MODEL}"

Internally it should:

* load and schema-check the input manifest;
* compose a role-specific prompt;
* invoke opencode run with the requested model;
* capture stdout/stderr separately;
* normalize the model response into agent-result.schema.json;
* fail closed if JSON validation fails;
* write a patch only into the ephemeral job workspace.

Start with AGENT_MODEL=opencode/big-pickle; leave the runtime capable of accepting a different model through an environment variable or approved job variable.

Deterministic validation

Do not let a reviewer model establish truth. tool-validation should run independently of the model and validate:

* result JSON schema;
* patch applies cleanly to the declared base revision;
* changed-file allowlist;
* formatter/linter;
* focused test command;
* absence of forbidden paths or secrets in artifacts.

The reviewer receives validation outputs and assesses quality or next steps, but its approval is informational in the first PoC.

Security and resource controls

* No repository-write or deployment credentials in this phase.
* Restrict the runner workspace to the checked-out target plus a dedicated artifact directory.
* Treat prompts, model output, and tool logs as potentially untrusted.
* Redact configured secret patterns before publishing artifacts.
* Add a global semaphore such as agent-model-free with a low initial limit, e.g. max: 2.
* Add execution timeout, output-size caps, and model-call retry policy in the Node runtime.
* Use an allowlist of tool commands; no arbitrary shell from model output.

Implementation phases

1. Local Zuul baseline
    * Bring up the sandbox and a minimal agent-runs project.
    * Confirm a manually enqueued change can execute an initializer and publish an artifact.
2. Contracts and runner
    * Define task/input/result schemas.
    * Implement the Node runner with a mock mode plus the opencode run adapter.
    * Unit-test malformed output, timeouts, and retry handling.
3. Planner-to-coder state passing
    * Implement run-agent.yaml.
    * Have planner return a compact plan manifest.
    * Pass its artifact reference and summary into coder.
4. Patch and deterministic validation
    * Let coder produce a patch artifact against a sample monorepo package.
    * Apply it only in the ephemeral Zuul workspace.
    * Run lint/tests/schema checks in tool-validation.
5. Review and run summary
    * Feed validation results and artifact references to reviewer.
    * Publish a final run-summary.json and human-readable Markdown report.
    * Have the Run API expose build URL/status and artifact links.
6. Hardening and demonstration
    * Demonstrate success, malformed agent output, model failure, invalid patch, and failed tests.
    * Confirm artifacts remain inspectable and no target-repo write occurs.

Definition of done

The PoC is complete when one API-submitted task produces a traceable Zuul buildset where:

* all three agent jobs run through Node-based opencode run wrappers;
* each job consumes only declared upstream state;
* coder produces a patch artifact;
* deterministic validation governs progression;
* reviewer produces a final structured assessment;
* the caller receives build status and links to a complete artifact bundle;
* failures are explicit, bounded, and do not mutate the target repository.
