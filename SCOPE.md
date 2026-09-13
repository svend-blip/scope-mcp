# scope-mcp — Project Scope

## 1. Purpose

Build a very small local MCP server called `scope-mcp`.

The purpose of `scope-mcp` is to allow DeepSeek Harness to receive a project scope and then work through that scope autonomously over potentially many context windows.

The intended user experience is:

1. The user opens DeepSeek Harness in a project workspace.
2. The user provides a project scope.
3. DeepSeek Harness reads and understands the scope.
4. DeepSeek Harness asks clarifying questions only when genuinely necessary.
5. DeepSeek Harness derives its own lightweight implementation goals from the scope.
6. DeepSeek Harness works through those goals autonomously.
7. DeepSeek Harness validates its work as it progresses.
8. Project state is persisted outside the active LLM context.
9. When context pressure becomes high, work can be checkpointed.
10. DeepSeek Harness can compact/reset active context and resume from the persisted project state.
11. Execution continues until the scope has been fulfilled or a genuine blocker requires user input.

The desired interaction should feel approximately like:

> Here is the scope. Ask me anything essential, then build it.

Everything after scope clarification should normally be autonomous.

## 2. Core Design Principle

Keep this system extremely simple.

This is NOT a smaller implementation of DPMtF.

Do not introduce:

* multi-agent orchestration
* supervisor agents
* decomposer agents
* implementer/reviewer chains
* prompt chains
* RUN abstractions
* complex governance
* workflow engines
* distributed execution
* unnecessary background services
* unnecessary infrastructure

Use one DeepSeek Harness agent and one model.

The model is responsible for intelligence.

`scope-mcp` is responsible only for small amounts of durable project/workflow state and simple guardrails.

## 3. Current Runtime

The initial environment is:

* Ubuntu Linux
* DeepSeek Harness
* local MCP
* FreeToken inference backend
* model alias: `freetoken-qwen38-flash-next-abliterated`
* served model: `Qwen3.8-Flash-Next-Abliterated-NVFP4`
* model context window: 262144 tokens

The MCP implementation must not depend specifically on this model.

Other models should be usable later without redesigning `scope-mcp`.

## 4. Responsibility Separation

Maintain a clean separation of responsibilities.

### DeepSeek Harness

Responsible for:

* agent runtime
* conversation/session handling
* tool execution
* context management
* context compaction
* interaction with the model

### LLM

Responsible for:

* understanding SCOPE.md
* asking necessary clarification questions
* decomposing scope into lightweight goals
* planning
* implementation
* reasoning
* deciding how to solve technical problems
* determining appropriate validation

### scope-mcp

Responsible only for:

* durable project state
* lightweight goal tracking
* current goal
* completed goals
* pending goals
* important decisions
* validation status
* unresolved blockers/issues
* next intended action
* checkpoints
* scope completion/coverage state

### Repository / Workspace

The repository itself remains the source of truth for:

* implementation
* files
* source code
* tests
* documentation
* configuration

Do not duplicate repository contents into MCP state.

## 5. Scope as the Project Contract

`SCOPE.md` represents the accepted project intent.

The normal lifecycle is:

SCOPE → clarification if required → accepted scope → autonomous execution → completion

After clarification, the scope should be treated as stable project intent.

The agent should not repeatedly ask questions that have already been answered by the scope or previous clarifications.

If a reasonable implementation decision can safely be made from the existing scope and repository state, the agent should make that decision itself.

User intervention should be requested only when:

* an important requirement is genuinely ambiguous
* mutually incompatible interpretations exist
* external information or authorization is required
* execution is genuinely blocked
* proceeding would create significant risk of violating the scope

The accepted scope and every later accepted addendum should also be persisted as durable project intent inside `scope-mcp`: one ordered base scope record plus its addenda, each with an acceptance timestamp and an active/effective flag. A cold start or fresh session then reconstructs the effective scope by loading the base record and its addenda in order, loads existing goals, progress, decisions, blockers and checkpoints, reconciles goals and coverage against that effective scope, preserves completed valid work, adjusts goals only where the effective scope requires it, and resumes from the recorded current goal / next action. The user should not need to paste the original scope or prior addenda again after a restart.

Reconciliation and interpretation stay with the model. `scope-mcp` only persists ordered scope documents and exposes them reliably: no version-control system for scopes, no workflow engine, no semantic planner inside the server.

## 6. Lightweight Goals

The user should NOT normally create goals manually.

DeepSeek Harness/the model derives goals from `SCOPE.md`.

Goals are simple work units, not orchestration objects.

A goal needs only enough information to support autonomous progress, for example:

* ID
* title
* status
* optional short description
* validation status

Typical statuses may be:

* pending
* active
* completed
* blocked

Avoid building a complex goal schema.

The goal list may evolve when implementation reveals necessary work, but changes must remain consistent with the accepted scope.

## 7. Persistent Project State

Maintain durable state that survives context compaction, session continuation, and process restart.

At minimum the state must make it possible to determine:

* project objective
* scope status
* accepted base scope and its ordered addenda, with acceptance order, timestamps, and active/effective status
* current goal
* completed goals
* pending goals
* important decisions
* validation status
* unresolved issues/blockers
* next action
* whether the project is complete

Use a simple local persistence mechanism.

Choose the simplest robust implementation.

SQLite is acceptable and preferred if it materially improves atomicity and restart safety without adding unnecessary complexity.

Do not build a database architecture larger than the problem requires.

## 8. MCP Interface

Expose a small MCP tool surface.

The exact names may be improved during implementation, but the conceptual capabilities should remain approximately:

* initialize project from scope
* record the accepted base scope
* append an accepted scope addendum in order
* read the effective scope (base plus ordered addenda)
* inspect project status
* establish/update generated goals
* get/select the current or next goal
* mark a goal complete with validation information
* record an important decision
* record/update blockers
* checkpoint current work state
* inspect scope coverage
* mark/check project completion

Prefer fewer well-designed tools over many specialized tools.

Do not put reasoning into MCP tools.

For example, `next_goal()` may return the next stored goal. It should NOT use its own planning algorithm to determine project architecture. The LLM performs that reasoning.

## 9. Checkpoint and Resume

A primary purpose of this project is to support work extending beyond one physical model context window.

Conceptually:

WORK → context pressure → checkpoint → context compaction/reset → restore project state → resume work → continue

Before context is compacted or discarded, sufficient durable state should exist to resume safely.

A checkpoint should preserve only useful working state such as:

* current goal
* work completed
* important decisions
* validation state
* unresolved issues
* next action

Do not attempt to persist the entire LLM conversation into `scope-mcp`.

DeepSeek Harness remains responsible for its own session/conversation persistence and compaction.

After compaction or a fresh context, the agent should be able to reconstruct its working position primarily from:

* `SCOPE.md`
* scope-mcp project state
* repository state
* relevant Harness session information

The repository is memory.

Do not copy large amounts of source code or conversation history into project state.

### Automatic checkpoint and automatic resume

Both halves should normally happen without the user asking.

* A checkpoint is persisted before useful working context is lost, using DeepSeek Harness's own lifecycle mechanism (hook/plugin extension point) rather than a scheduler, daemon, background monitor, or polling loop.
* After compaction or a fresh context, the agent reads the persisted state and continues from the recorded next action without the user reconstructing previous progress.
* Prefer a native Harness extension point. Where the installed Harness version has no suitable pre-compaction event, use the smallest reliable alternative that achieves the same practical result and document that limitation.
* Ordinary short sessions must not accumulate excessive or unnecessary checkpoints.

`scope-mcp` stays responsible for durable project/work state only: it does not duplicate Harness session persistence, does not add multi-agent behaviour, and does not manage contexts itself.

### Capability-based integration

Integration level is chosen from what the installed Harness version and profile actually provide, not from platform or profile names:

* Level A: local MCP + skills + lifecycle hooks with context injection — automatic checkpoint and automatic resume.
* Level B: local MCP + skills, no usable lifecycle hooks — the same durable state driven by explicit `checkpoint` / `status` calls. Still a supported installation.
* Level C: local MCP only — the tools work, and the agent's own instructions must call `checkpoint` before stopping and `status` when a context opens.
* Unsupported only where there is no local MCP and no equivalent supported tool interface.

Rules that go with it:

* Differences between profiles and operating systems stay in installation and configuration. The state layer stays platform-neutral and does not learn about specific profiles.
* Skills install through whatever skill mechanism the installed version actually scans; the repository stays canonical, copying being a documented fallback.
* Missing lifecycle hooks degrade to manual skills plus MCP tools. Do not compensate with polling, screen scraping, UI automation, a daemon, or an external context monitor.
* Without a real pre-compaction event the guarantee stays what it is: checkpoint at the latest supported turn/lifecycle boundary.
* Support claims distinguish Tested from Inspected and Expected.

## 10. Virtual Long-Running Context

The system should make it practical for a model with a finite context window, such as 256K, to complete projects requiring substantially more total work across multiple context windows.

This is not intended to emulate native attention over a 1M-token context.

Instead, it provides persistent working continuity across repeated context windows.

The design should optimize for:

* safe forgetting
* reliable resume
* minimal state
* low context overhead
* low operational complexity

## 11. Autonomous Execution Behaviour

Once scope clarification is complete, DeepSeek Harness should normally continue without asking the user for permission after each goal.

Conceptually:

READ SCOPE → inspect persistent state → determine current goal → work → validate → update persistent state → determine next goal → continue

When context pressure requires compaction:

update state → checkpoint → compact/reset → restore state → continue

When all goals appear complete:

review SCOPE.md → verify scope coverage → perform final validation → fix remaining gaps if necessary → mark project complete → report completion to user

## 12. Scope Coverage

Goal completion alone must not automatically mean project completion.

Before declaring completion, the agent must compare the resulting repository against the accepted `SCOPE.md`.

The completion process should identify:

* fulfilled requirements
* unfulfilled requirements
* intentionally deferred requirements, if any
* validation performed
* unresolved blockers, if any

Only mark the project complete when the scope is reasonably satisfied.

## 13. Recovery

The system should recover cleanly after:

* DeepSeek Harness restart
* MCP server restart
* context compaction
* new active context
* interrupted execution

The agent should be able to inspect project state and continue without requiring the user to reconstruct previous progress manually.

## 14. Local MCP

`scope-mcp` should initially run locally.

Prefer the simplest MCP transport supported cleanly by DeepSeek Harness.

If stdio provides the simplest reliable solution, prefer stdio.

Do not introduce HTTP services, authentication, networking, containers, or deployment infrastructure unless actually necessary.

Keep stdio as the default transport on every Harness profile and operating system. Another transport is added only when a target environment genuinely lacks stdio, and then as a thin adapter over the same state layer.

## 15. Security and Workspace Boundaries

The MCP server must operate only on its intended project state.

Do not give `scope-mcp` broad filesystem responsibilities.

DeepSeek Harness already has workspace/file tools.

`scope-mcp` should not become another filesystem abstraction.

Avoid arbitrary command execution inside the MCP server.

State stays workspace-local: `<workspace>/.scope-mcp/state.db`, overridable by `SCOPE_MCP_DB`, resolved with platform path APIs from the active workspace. The location of the scope-mcp package itself is a separate concept and never decides where state is written, so one installed package serves any number of projects and the repository may live anywhere. Paths are built with platform-aware APIs, not string concatenation, and no path is hard-coded for one machine.

## 16. Observability

Keep observability minimal but useful.

It should be easy to determine:

* current project
* current goal
* progress
* last checkpoint
* current blockers
* validation status
* completion state

Human-readable status output is desirable.

Do not build a monitoring platform.

One read-only diagnostic command may report the runtime facts an integrating agent needs: version, Node runtime and `node:sqlite` availability, package location, active workspace, resolved state path and writability, discovered Harness home / profiles / skill roots, and the Harness variables in view. It must not mutate configuration and must not become an installer framework.

## 17. Testing

Provide automated tests for the important state transitions and MCP behaviour.

At minimum test:

* project initialization
* goal creation/update
* goal progression
* checkpoint persistence
* restart/reload
* decision persistence
* blocker persistence
* completion state
* invalid state transitions where relevant
* automatic checkpoint through the chosen Harness integration mechanism
* resume in a fresh context from persisted state alone, including the next action
* ordinary short sessions producing no unnecessary checkpoints
* workspace state isolation across several workspaces, including workspace paths containing spaces
* portable path and state resolution: workspace-derived state file, override variable, leading-`~` expansion, package location not leaking into state paths
* the read-only diagnostic helper reporting runtime capability and resolved paths without rewriting configuration
* hook commands and skills resolving through Harness-provided substitution rather than one machine path

Keep tests proportional to the simplicity of the project. Platform coverage comes from platform-aware APIs and real filesystem checks, not from string constants standing in for another operating system.

## 18. Documentation

Provide a concise README explaining:

* what scope-mcp does
* why it exists
* architecture
* installation
* how to connect it to DeepSeek Harness
* how to start a new scope-driven project
* how state/checkpoint/resume works
* how automatic checkpointing works and what triggers it
* how automatic resume works, and which Harness configuration it needs
* how integration level is detected from installed capabilities, with an evidence-based compatibility matrix that separates Tested, Inspected and Expected
* how to install for a chosen profile or set of profiles, how repeated installation converges instead of duplicating entries, and how to uninstall
* how to verify the runtime and inspect the environment before wiring anything in
* limitations of the current DeepSeek Harness version
* how to inspect current state

The primary usage should be extremely easy.

The target user experience should ultimately be close to:

1. Open a project workspace in DeepSeek Harness.
2. Provide `SCOPE.md` or paste a project scope.
3. Answer necessary clarification questions.
4. Let the agent work autonomously.

## 19. Implementation Philosophy

Prefer:

* small codebase
* few dependencies
* explicit state
* deterministic state transitions
* simple MCP tools
* easy debugging
* easy removal/reinstallation
* platform-neutral operation wherever the installed Harness provides the needed capability

Avoid speculative extensibility.

Do not build functionality merely because it might be useful later.

Implement the smallest system that proves the concept reliably.

## 20. Definition of Done

The project is complete when:

1. A local `scope-mcp` server can be connected to DeepSeek Harness.
2. DeepSeek Harness can initialize project state from a scope.
3. The model can create and maintain lightweight goals.
4. The model can determine and persist current progress.
5. Completed and pending work survives restart.
6. Important decisions and validation state survive restart.
7. The model can checkpoint before context compaction, and ordinary turn boundaries checkpoint automatically through Harness hooks.
8. A subsequent/fresh context can inspect state and resume work automatically, without the user restating previous progress.
9. The accepted base scope and its ordered addenda are persisted, and a cold start reconstructs the effective scope and reconciles goals without the user re-supplying either document.
10. The model can evaluate scope coverage before completion.
11. The MCP server does not contain unnecessary planning or orchestration intelligence.
12. Automated tests pass.
13. README documents the complete minimal workflow.
14. A small end-to-end demonstration proves: SCOPE → generated goals → execution progress → checkpoint → resume → scope coverage → completion
15. No core path or instruction depends on one machine layout: repository location, Node executable, Harness home, profile name and skill root are all detected rather than assumed.
16. Integration level is chosen from detected capabilities, missing lifecycle hooks degrade to manual skills plus MCP tools, and every support claim states whether it was Tested or only Inspected/Expected.
17. Installation is idempotent, targets only the profiles in use, preserves unrelated configuration, and uninstall removes the integration while keeping project state.

## 21. Initial Execution Instruction

First:

1. Persist this message as `SCOPE.md`.
2. Inspect the current workspace.
3. Determine whether any clarification is genuinely necessary.
4. If necessary, ask all important initial clarification questions together rather than one at a time.
5. If no clarification is required, proceed directly.

After clarification:

* create a lightweight implementation plan
* implement autonomously
* validate continuously
* keep the implementation minimal
* do not wait for approval between ordinary implementation steps
* continue until the Definition of Done is satisfied or a genuine blocker requires user input

Do not recreate DPMtF.

The success criterion is simplicity: a user should eventually be able to hand DeepSeek Harness a scope and let one model work through it reliably across multiple context windows.

---

### Accepted clarifications

* State location: inside the workspace at `.scope-mcp/state.db`.
* Dependencies: official `@modelcontextprotocol/sdk` on npm for MCP framing; SQLite via Node's built-in `node:sqlite`.
