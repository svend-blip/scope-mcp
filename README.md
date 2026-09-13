# scope-mcp

A very small local MCP server that holds **durable project state** so one DeepSeek Harness agent — one model — can work through a project scope across many context windows.

Read [`SCOPE.md`](SCOPE.md) for the accepted project intent.

## What it does

`scope-mcp` stores and reports:

* the project objective and scope file (`SCOPE.md`)
* lightweight goals derived from the scope (pending / active / completed / blocked) and which goal is current
* validation evidence per completed goal
* important decisions
* open blockers
* checkpoints (the working position to resume from)
* scope coverage and completion state

That is all. Reasoning, planning, decomposition, and validation choices stay with the model; the server only stores state and applies a few deterministic guardrails.

## Why it exists

A model with a finite context window (say 256K) still has to finish projects that need more total work than one window holds. Instead of a bigger context, `scope-mcp` gives *continuity*: state lives in a SQLite file next to the repository, so after compaction, a session restart, or a fresh context, the agent reads `SCOPE.md` + `status` and knows exactly where it was.

This is not native 1M-token attention. It is safe forgetting plus reliable resume: minimal state, low context overhead, low operational complexity.

## Architecture

```
Workspace
├── SCOPE.md              accepted scope, project contract (source of truth for intent)
├── src/, tests, docs     repository work (source of truth for implementation)
└── .scope-mcp/state.db   scope-mcp state (SQLite, one small file)

DeepSeek Harness  → runtime, session, tools, context compaction
Model             → understanding the scope, goals, planning, coding, validation
scope-mcp         → durable state + simple guardrails (stdio MCP server)
```

Three files:

| File | Role |
| --- | --- |
| `src/state.js` | SQLite schema, deterministic state transitions, human-readable status rendering |
| `src/tools.js` | MCP tool adapters: parse args, call state, return text |
| `src/server.js` | Entry point: stdio transport, plus `--status` / `--db` / `--help` CLI |

Dependencies: `@modelcontextprotocol/sdk` (framing) and `zod` (its required peer). Storage uses Node's built-in `node:sqlite` — no DB server, no daemon. Transport is stdio: no HTTP service, no ports, no auth.

## Installation

Requires Node.js >= 22.5 (for built-in `node:sqlite`). Linux-first.

```bash
cd /path/to/scope-mcp
npm install            # if ~/.npm is read-only: npm_config_cache=./.npm-cache npm install
npm test               # state + MCP round-trip tests
npm run demo           # end-to-end walkthrough of the whole lifecycle
```

Remove it again by deleting `.scope-mcp/` in the workspace and the npm package — there is no daemon, no global state, nothing to migrate.

## Connect it to DeepSeek Harness

Register it as a stdio MCP server for the session. Harness requires an absolute `command` path:

```json
{
  "mcpServers": [
    {
      "name": "scope-mcp",
      "command": "/usr/bin/node",
      "args": ["/absolute/path/to/scope-mcp/src/server.js"],
      "env": { "SCOPE_MCP_DB": "/absolute/path/to/project/.scope-mcp/state.db" }
    }
  ]
}
```

`SCOPE_MCP_DB` is optional; without it the state file is `<cwd>/.scope-mcp/state.db`, which is what you want when the agent runs in the project workspace.

Check that the server answers:

```bash
node src/server.js --status     # prints current state (or "not initialized") and exits
```

Note for programmatic clients: call tools with the object form `callTool({ name, arguments })`. Some SDK client builds treat the two-positional-argument shorthand inconsistently.

## Start a new scope-driven project

1. Put the accepted scope in `SCOPE.md` in the workspace (or paste it and have the agent write it).
2. Answer the agent's essential clarification questions once. The clarifications become decisions, and the scope is then stable intent.
3. Say something like: *"Here is the scope. Ask anything essential, then build it."*

The agent then loops autonomously:

```
read SCOPE.md → status → next_goal → work → validate → complete_goal
              → record_decision / record_blocker → continue
```

Typical calls:

```jsonc
init_project   { "objective": "Build scope-mcp: durable scope-driven project state.", "scope_file": "SCOPE.md" }
set_goals      { "goals": [{ "id": "g1", "title": "SQLite state layer" }, { "id": "g2", "title": "tests + README" }] }
next_goal      {}                                        // -> "current goal: g1: SQLite state layer"
complete_goal  { "goal_id": "g1", "validation": "npm test: 15 pass" }
record_decision{ "text": "stdio transport, one sqlite file per workspace" }
checkpoint     { "next_action": "complete g2, then coverage + complete_project" }
coverage       { "items": [{ "requirement": "state survives restart", "status": "fulfilled", "note": "reload tests" }] }
complete_project {}                                      // guardrail-checked completion
```

No permission prompts between ordinary goals. The agent interrupts the user only for genuinely ambiguous requirements, conflicting interpretations, missing external access/authorization, or a real blocker.

## Tools

| Tool | Purpose |
| --- | --- |
| `init_project` | Record objective + scope file; idempotent; returns the current working position |
| `status` | Human-readable resume surface: goal, progress, validation, coverage, blockers, decisions, last checkpoint |
| `set_goals` | Establish/update the generated goal list (known statuses preserved, completed goals kept) |
| `next_goal` | Read the current goal, optionally select one by id |
| `complete_goal` | Complete a goal with required validation evidence; promotes the next goal |
| `record_decision` | Store a durable decision so later contexts do not re-litigate it |
| `record_blocker` | Store an unresolved issue, optionally stopping one goal |
| `resolve_blocker` | Close a blocker by number |
| `checkpoint` | Snapshot the working position before compaction; omitted fields are filled from stored state |
| `coverage` | Map SCOPE.md requirements to fulfilled / deferred / missing |
| `complete_project` | Complete only when goals are done and coverage has no gaps; otherwise reports what is left (`force: true` overrides) |

## State, checkpoint, resume

```
WORK → context pressure → checkpoint → compact/reset context → status → resume → WORK
```

* `checkpoint` writes one row containing the current goal, work completed, important decisions, validation state, unresolved issues, and the next action. Anything you omit is filled from stored state, so `checkpoint {"next_action": "..."}` is usually enough. Keep it short — summaries, not transcripts.
* Conversation history is *not* stored here. Harness owns session persistence and compaction; the repository is memory.
* Recovery after Harness restart, MCP server restart, compaction, or a brand-new context is the same: read `SCOPE.md`, call `status`, continue. The SQLite file (WAL journal, `synchronous = FULL`) survives process death between statements.

A fresh context's opening move is usually two calls: `status`, then `next_goal`.

## Inspect current state

From inside a session: the `status` tool. From a shell:

```bash
node src/server.js --status
node src/server.js --db /other/project/.scope-mcp/state.db --status
sqlite3 .scope-mcp/state.db 'select id,status,title from goals;'
```

Status shows project/objective, scope status, goal counts and the current goal, validation evidence, coverage counts, completion timestamp, open blockers, recent decisions, and the last checkpoint's next action.

## Completion

Completing every goal is not completion. Before declaring done, the agent records coverage per scope requirement and calls `complete_project`, which reports unfulfilled requirements, unfinished goals, deferred items with reasons, open blockers, and the validation collected. Fix gaps, or pass `force: true` when a deferral is intentional, then complete.

## Testing and demo

```bash
npm test     # 16 tests: init, goal create/update/progression, checkpoints, reload-after-restart,
             # decisions, blockers, coverage, completion guardrails, MCP round-trips
npm run demo # SCOPE → goals → progress → checkpoint → resume (new process) → coverage → completion
```

Both are self-contained; the demo uses its own temporary database file.
