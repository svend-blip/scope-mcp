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
├── hooks.json            Harness hook config: checkpoint on Stop, resume brief on SessionStart
├── src/, tests, docs     repository work (source of truth for implementation)
└── .scope-mcp/state.db   scope-mcp state (SQLite, one small file)

DeepSeek Harness  → runtime, session, lifecycle hooks, context compaction
Model             → understanding the scope, goals, planning, coding, validation
scope-mcp         → durable state + simple guardrails (stdio MCP server + hook commands)
```

Four files:

| File | Role |
| --- | --- |
| `src/state.js` | SQLite schema, deterministic state transitions, human-readable status rendering |
| `src/tools.js` | MCP tool adapters: parse args, call state, return text |
| `src/hooks.js` | Harness hook handlers: automatic checkpoint on `Stop`, resume brief on `SessionStart` |
| `src/server.js` | Entry point: stdio transport, plus `--status` / `hook <event>` / `--db` / `--help` CLI |

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
      "env": [{ "name": "SCOPE_MCP_DB", "value": "/absolute/path/to/project/.scope-mcp/state.db" }]
    }
  ]
}
```

Harness accepts two MCP transports: omit `type` for stdio (shown above), or `{ "type": "http", "url": "..." }` for Streamable HTTP. `command` must be an absolute path, and `env` / `headers` are ordered `{ "name", "value" }` entries rather than plain maps.

`SCOPE_MCP_DB` is optional; without it the state file is `<cwd>/.scope-mcp/state.db`, which is what you want when the agent runs in the project workspace.

Check that the server answers:

```bash
node src/server.js --status     # prints current state (or "not initialized") and exits
```

Note for programmatic clients: call tools with the object form `callTool({ name, arguments })`. Some SDK client builds treat the two-positional-argument shorthand inconsistently.

Both are the same server: the block above registers it for one session, and [Harness configuration required](#harness-configuration-required) shows the profile-level YAML that mounts it permanently together with the hook row that makes checkpointing automatic.

## Automatic checkpoint and resume

Both directions work without anyone asking for them.

**Automatic checkpoint.** Harness runs [`hooks.json`](hooks.json) through its hooks bridge. At each turn boundary (`Stop`) the bridge executes `scope-mcp hook stop`, which writes one checkpoint: current goal, work completed, validation state, important decisions, unresolved issues, and the exact next action. Fields that are not passed in are derived from stored state, so an unattended checkpoint is still complete. Writing stays cheap: an unchanged snapshot reuses the previous row, an empty store writes nothing at all, and only the newest 50 rows are kept. An ordinary short session ends with one or two checkpoints, not one per message.

**Automatic resume.** `SessionStart` runs `scope-mcp hook session-start`. The command replies in the shape Harness decodes — `hookSpecificOutput.additionalContext` — so the resume brief (objective, current goal, exact next action, completed work with its validation, open blockers, checkpoint time) is injected into the new context as it opens, and the agent continues from the recorded next action on its own. `UserPromptSubmit` carries the same brief for a context that opened without a `SessionStart` hook; it injects once per session id and stays silent afterwards, so it does not repeat on every prompt.

Explicit calls still win: `checkpoint { "next_action": "..." }` records a precise instruction that automatic checkpoints keep while the same goal is active, then fall back to the active goal once work moves on.

### Harness configuration required

Both the MCP server row and the hooks row live in the profile's patch layer, `$DSH_HOME/profiles/<profile>/cordis.patch.yml` (`$DSH_HOME` is usually `~/.dsh`):

```yaml
- insert:
    - id: mcp-scope-mcp
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: scope-mcp
        transport: stdio
        command: /absolute/path/to/node
        args: [/absolute/path/to/scope-mcp/src/server.js]
        cwd: /absolute/path/to/project
    - id: hooks-scope-mcp
      name: '@deepseek-ai/dsh-hooks-claude-code'
      config:
        configPath: /absolute/path/to/scope-mcp/hooks.json
```

`patchReload: live` (the shipped `web` profile) picks the patch up without a restart; other profiles need a new session. If the bridge package is missing from the profile: `dsh plugin --profile web add @deepseek-ai/dsh-hooks-claude-code`.

Hook commands run with cwd set to the session workspace and `CLAUDE_PROJECT_DIR` exported, so state lands in `<workspace>/.scope-mcp/state.db` unless `SCOPE_MCP_DB` says otherwise. Keep the paths in `hooks.json` absolute (or use `${CLAUDE_PROJECT_DIR}`): hooks do not inherit an interactive shell's aliases. Verify without opening a session:

```bash
node src/server.js hook stop           # writes the checkpoint, prints one line
node src/server.js hook session-start  # prints the JSON block a fresh context receives
node src/server.js --status            # full working position
```

### Limitations in this Harness version (0.1.5-rc.1)

* The hooks bridge supports `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`, `SubagentStart`, `SubagentStop`. There is **no dedicated pre-compaction event**: automatic compaction runs inside the agent loop (context pressure at the step boundary, plus context-overflow recovery) and fires no hook event of its own. Checkpointing at every turn boundary covers it — durable state is at most one turn old when compaction runs — and `/compact` keeps its own summary next to it.
* Only `SessionStart`, `UserPromptSubmit` and `PostToolUse` surface a hook's `additionalContext`; a `Stop` hook contributes state through its side effect only. Top-level `systemMessage` and `updatedInput` are ignored by the bridge today.
* Compaction itself stays entirely inside Harness. `scope-mcp` never stores conversation history: the SQLite file holds goals, validation, decisions, blockers, checkpoints and coverage.
* The shipped `web` / `headless` profiles do not mount the hooks bridge, so its row has to be added once per profile. Without it, everything still works through explicit tool calls — `checkpoint` before a session ends, `status` after a fresh context opens.

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
| `checkpoint` | Snapshot the working position; omitted fields are filled from stored state (Harness hooks call this automatically at turn boundaries) |
| `coverage` | Map SCOPE.md requirements to fulfilled / deferred / missing |
| `complete_project` | Complete only when goals are done and coverage has no gaps; otherwise reports what is left (`force: true` overrides) |

## State, checkpoint, resume

```
WORK → turn boundary → checkpoint written → compaction/reset → brief injected → WORK
```

* `checkpoint` writes one row containing the current goal, work completed, important decisions, validation state, unresolved issues, and the next action. Anything you omit is filled from stored state, so `checkpoint {"next_action": "..."}` is usually enough. Keep it short — summaries, not transcripts. Harness hooks call the same path automatically (see [Automatic checkpoint and resume](#automatic-checkpoint-and-resume)).
* Conversation history is *not* stored here. Harness owns session persistence and compaction; the repository is memory.
* Recovery after Harness restart, MCP server restart, compaction, or a brand-new context is the same: the resume brief arrives with the new context, then `SCOPE.md` + `status` fill in the details. The SQLite file (WAL journal, `synchronous = FULL`) survives process death between statements.

With the hooks row configured, a fresh context already holds the goal and next action; the opening move is then `status` only when more detail is needed.

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
npm test     # 24 tests: init, goal create/update/progression, checkpoints, reload-after-restart,
             # decisions, blockers, coverage, completion guardrails, MCP round-trips,
             # hook-driven checkpoint and fresh-context resume
npm run demo # SCOPE → goals → progress → checkpoint → resume (new process) → coverage → completion
```

Both are self-contained; the demo uses its own temporary database file.
