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
| `src/server.js` | Entry point: stdio transport, plus `--status` / `--doctor` / `--checkpoint` / `--db` / `--help` CLI |

Dependencies: `@modelcontextprotocol/sdk` (framing) and `zod` (its required peer). Storage uses Node's built-in `node:sqlite` — no DB server, no daemon. Transport is stdio: no HTTP service, no ports, no auth.

## Compatibility

| Platform / Harness surface | Status |
| --- | --- |
| Linux Web | Tested — Level A |
| Linux Headless | Tested — Level A |
| Windows Web | Tested — Level A |
| Windows Headless | Inspected / expected unless separately tested |
| Desktop / Electron | Inspected / expected unless separately tested |
| macOS | Inspected / expected unless separately tested |
| Custom profiles | Supported through profile discovery; actual automation level depends on available MCP/hooks/skills mechanisms |

This table records what has actually been executed, not what is assumed to work. "Inspected / expected" means the mechanism should apply but has not been run end-to-end on that surface.

### Level A — Full automation

* scope-mcp MCP tools available
* project-local durable state
* automatic checkpoint through Harness hooks
* automatic resume context injection
* skills available through the Harness skill mechanism

### Level B — Manual durable-state operation

* scope-mcp MCP tools available
* durable project state works
* manual `checkpoint` / `status` / resume workflow works
* automatic hooks are unavailable or not configured

## Native Windows validation

The following behavior has been demonstrated successfully on native Windows:

* DeepSeek Harness Web starts successfully.
* Built-in Harness tools execute normally.
* scope-mcp MCP tools execute normally.
* scope-mcp state is isolated per project workspace.
* `SessionStart` automatically injects the scope-mcp resume brief.
* The resume brief restores:
  * objective
  * current goal
  * progress
  * validation state
  * decisions
  * unresolved issues
  * exact next action
* MCP `status` agrees with the injected resume state.
* `PostToolUse` hooks execute successfully.
* `Stop` hooks execute successfully.
* changed state produces a durable checkpoint.
* unchanged state is deduplicated/idempotently skipped.
* a fresh Harness session can resume work without depending on previous conversation history.
* Windows-native filesystem paths work correctly.
* paths containing drive letters are handled correctly.
* no `C:\C:\...` path duplication remains.
* `node:sqlite` works with the validated Node runtime.

Reference environment:

```text
Windows 10 Pro 64-bit
Node.js v24.19.0
npm/npx 11.17.0
DeepSeek Harness 0.1.5-rc.1
Harness Web profile
```

These versions describe the validated environment. They are not hard version pins: the repository's own requirement remains Node.js >= 22.5 (for built-in `node:sqlite`), and newer Harness versions are expected to keep working — see the Windows sandbox note below for the one version-specific caveat.

## Installation

Requires Node.js >= 22.5 (for built-in `node:sqlite`). Works on Linux, macOS, and Windows.

```bash
cd /path/to/scope-mcp
npm install            # if the cache is read-only: npm_config_cache=./.npm-cache npm install
npm test               # state + MCP + hook + path-regression suites
npm run demo           # end-to-end walkthrough of the whole lifecycle
```

Remove it again by deleting `.scope-mcp/` in the workspace and the npm package — there is no daemon, no global state, nothing to migrate.

The rest of this document covers two installation paths: [AI-assisted installation](#ai-assisted-installation) (recommended) and [manual installation](#manual-installation) (Linux/macOS and Windows PowerShell), followed by [installation validation](#installation-validation).

## Connect it to DeepSeek Harness

Register scope-mcp as a stdio MCP server for the session. Harness requires an absolute `command` path — discover your real node executable instead of guessing (`which node` / `Get-Command node`):

```json
{
  "mcpServers": [
    {
      "name": "scope-mcp",
      "command": "<node-exe>",
      "args": ["<scope-mcp-dir>/src/server.js"],
      "env": [{ "name": "SCOPE_MCP_DB", "value": "<workspace>/.scope-mcp/state.db" }]
    }
  ]
}
```

Harness accepts two MCP transports: omit `type` for stdio (shown above), or `{ "type": "http", "url": "..." }` for Streamable HTTP. `command` must be an absolute path, and `env` / `headers` are ordered `{ "name", "value" }` entries rather than plain maps.

`SCOPE_MCP_DB` is optional; without it the state file is `<cwd>/.scope-mcp/state.db`, which is what you want when the agent runs in the project workspace.

### DeepSeek Harness profile (native, incl. Windows)

The harness composes profiles from patch layers. Add these rows to the profile's `cordis.patch.yml`. Use runtime-discovered, native absolute paths — never copy paths from another machine:

```yaml
- insert:
    - id: mcp-scope-mcp
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: scope-mcp
        transport: stdio
        command: <node-exe>            # e.g. from `Get-Command node` / `which node`
        args:
          - --no-warnings
          - <scope-mcp-dir>\src\server.js
        cwd: <harness-home>            # one server per profile; sessions pass their workspace explicitly
    - id: hooks-scope-mcp
      name: '@deepseek-ai/dsh-hooks-claude-code'
      config:
        configPath: <scope-mcp-dir>\scripts\hooks.json
```

The harness spawns **one MCP server per profile**, so sessions pass their workspace explicitly: every tool accepts an optional `workspace` argument and then reads/writes `<workspace>/.scope-mcp/state.db`. Pass the session working directory (`pwd` in the shell tool). Omit `workspace` to use the server's own default state file instead.

The hooks entry (`scripts/hooks.json`) wires three automatic hooks, which run with the session workspace as cwd:

* `SessionStart` → `node scripts/scope-hooks.js resume` injects the stored working position into the fresh session as context.
* `Stop` → `node scripts/scope-hooks.js checkpoint` snapshots the working position when a run stops, only when it changed.
* `PostToolUse` → `node scripts/scope-hooks.js marker` writes a diagnostic line per hook invocation.

Generate `hooks.json` with your discovered node executable and checkout directory. The file checked into this repository is a machine-specific example from the validated Windows environment (marked as such); do not reuse its absolute paths.

For the guided versions, install the two skills into `<dshHome>/skills` (`~/.dsh/skills`): copy `skills/save-checkpoint` and `skills/resume-work` from this repository. The harness watches that directory, so they appear in the session catalog without a restart.

Check that the server answers:

```bash
node src/server.js --status     # prints current state (or "not initialized") and exits
node src/server.js --doctor     # read-only environment diagnostic (see Doctor)
```

Note for programmatic clients: call tools with the object form `callTool({ name, arguments })`. Some SDK client builds treat the two-positional-argument shorthand inconsistently.

## Windows: hook sandbox limitation (Harness 0.1.5-rc.1)

On the tested DeepSeek Harness 0.1.5-rc.1 Windows Web configuration, scope-mcp hook commands execute as session-less direct shell calls under the Harness deployment sandbox policy. With the default sandboxed Windows PowerShell executor, the Windows ACL runner can confine those hook child processes to the Harness server launch workspace. If the active project is another workspace, the hook can therefore fail to open or write `<workspace>/.scope-mcp/state.db`, producing `unable to open database file`.

The MCP server itself is not the problem.

Per-session Harness tool execution is not the problem.

The issue is specifically the deployment policy inherited by session-less hook shell calls.

Symptom pattern: MCP tools work and read/write the workspace state normally, while automatic hooks fail. The Stop hook reports `scope-mcp hook: Error: unable to open database file` (the hook exits 0 by design, so the failure is visible only in hook logs/stderr records — check them, do not assume success because the session continued).

## Windows: required workaround for Level A hooks

For the currently validated Harness version (0.1.5-rc.1), Level A Windows hook automation requires the deployment sandbox policy used by session-less hook calls to allow full filesystem access:

```yaml
- id: sandbox-policy
  config:
    mode: danger-full-access
```

Apply this as an id-targeted override in the active profile's `cordis.patch.yml`. A workspace-write root instead is *not* sufficient on Windows: the ACL runner requires the platform temp directory to be outside the workspace root, so a root broad enough to cover several sibling project workspaces is rejected.

Never blindly overwrite an existing Harness configuration. Merge the setting using the same safe profile-patching procedure as every other change:

1. inspect the effective Harness/profile configuration;
2. preserve unrelated settings;
3. create a backup where the current installer already uses backups;
4. modify only what is required;
5. validate the resulting profile before declaring installation successful.

Do not hard-code machine specifics anywhere in configuration or documentation: no fixed usernames, no fixed node executable paths, no fixed checkout directories, no fixed profile names. Use runtime discovery.

Per-session tool execution keeps its own session policy; this override only changes the deployment policy that session-less calls (like the hook child processes) inherit.

## Security warning: `danger-full-access`

```text
danger-full-access
```

reduces sandbox isolation for the deployment context to which it applies. It is **not harmless**; it is a deliberate trade-off. scope-mcp currently needs it on the validated Windows setup because:

* the Harness invokes these hooks outside the normal project session sandbox,
* scope-mcp must write durable state into the active project's `.scope-mcp` directory,
* the tested Windows ACL sandbox prevents that when the project is outside the Harness server launch workspace.

This is a **Harness 0.1.5-rc.1 integration limitation**, not a fundamental scope-mcp architectural requirement. If a future Harness version provides a safe mechanism for session-less hooks to inherit the active session workspace permissions, scope-mcp should prefer that mechanism and the `danger-full-access` workaround should become unnecessary.

`danger-full-access` is not a universal requirement: it does not apply to Linux/macOS and must not be applied to future Harness versions blindly. Require explicit user approval before introducing or changing to `danger-full-access`.

## AI-assisted installation

Recommended when an AI agent has filesystem and Harness configuration access. The agent must first detect, in order:

* operating system
* Harness version
* Harness home
* available profiles
* active/target profile
* Node executable
* Node version
* `node:sqlite` capability
* MCP client availability
* hooks bridge availability
* skill roots
* existing scope-mcp configuration

Then choose the appropriate installation path:

1. inspect environment (the list above; `scope-mcp doctor` helps);
2. run `scope-mcp doctor`;
3. detect Harness profiles;
4. configure MCP;
5. install/discover the two skills;
6. configure hooks when supported;
7. handle the Windows sandbox requirement when applicable;
8. validate the installation;
9. report the achieved compatibility level (Level A or Level B).

For **Windows + Harness 0.1.5-rc.1 Web**, the installer must additionally inspect the deployment sandbox configuration. If Level A hooks would otherwise be unable to write project-local scope state, explain the required `danger-full-access` deployment-policy change to the user **before** applying it. Do not silently weaken sandbox security; require explicit user approval.

If the user declines, install/configure scope-mcp as **Level B** instead:

* MCP durable state remains available.
* manual `save-checkpoint` works.
* manual `resume-work` works.
* automatic hook behavior must not be claimed.

## Manual installation

### Linux / macOS

```bash
# 1. install and verify
cd /path/to/scope-mcp
npm install
npm test
npm run demo

# 2. register the MCP server and hooks in the active profile's cordis.patch.yml
#    (see "Connect it to DeepSeek Harness"; use `which node` for the command path)

# 3. install the two skills (adjust DSH home as needed)
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
mkdir -p "$DSH_HOME/skills"
cp -r skills/save-checkpoint skills/resume-work "$DSH_HOME/skills/"

# 4. verify
node src/server.js --status
node src/server.js --doctor
```

### Windows (PowerShell)

```powershell
# 1. install and verify
Set-Location <scope-mcp-dir>
npm install
npm test
npm run demo

# 2. register the MCP server and hooks in the active profile's cordis.patch.yml
#    (see "Connect it to DeepSeek Harness"); discover the node executable with:
(Get-Command node).Source

# 3. install the two skills into the harness skills root
$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME '.dsh' }
$skillsRoot = Join-Path $dshHome 'skills'
New-Item -ItemType Directory -Force -Path $skillsRoot | Out-Null
Copy-Item -Recurse -Force skills\save-checkpoint, skills\resume-work $skillsRoot

# 4. generate hooks.json from discovered paths (do not copy another machine's file)
$node = (Get-Command node).Source
$hook = (Resolve-Path scripts\scope-hooks.js).Path
@"
{
  "hooks": {
    "SessionStart": [ { "matcher": "", "hooks": [ { "type": "command", "command": "& '$node' --no-warnings '$hook' resume" } ] } ],
    "Stop": [ { "matcher": "", "hooks": [ { "type": "command", "command": "& '$node' --no-warnings '$hook' checkpoint" } ] } ],
    "PostToolUse": [ { "matcher": "", "hooks": [ { "type": "command", "command": "& '$node' --no-warnings '$hook' marker" } ] } ]
  }
}
"@ | Set-Content -Encoding utf8 scripts\hooks.json

# 5. on Harness 0.1.5-rc.1 Web, for Level A hooks: merge the sandbox-policy
#    override into the active profile's cordis.patch.yml (see "Windows: required
#    workaround for Level A hooks") — with explicit user approval first.

# 6. verify
node src\server.js --status
node src\server.js --doctor
```

## Installation validation

After installation, prove behavior rather than merely verifying that files exist.

For Level A, validate:

1. scope-mcp MCP tools are visible.
2. `status` can be called.
3. a disposable project/workspace gets its own `<workspace>/.scope-mcp/state.db`.
4. another workspace receives an independent state database.
5. `save-checkpoint` skill is discovered.
6. `resume-work` skill is discovered.
7. `SessionStart` injects the resume brief.
8. the resume brief agrees with MCP `status`.
9. `PostToolUse` executes successfully where configured.
10. `Stop` creates or deduplicates a checkpoint correctly.
11. a completely fresh session can recover the active goal and exact next action without previous conversation history.
12. no hook/database/sandbox/tool-dispatch error remains.

On Windows, specifically check for:

```text
unable to open database file
```

and treat its occurrence in automatic hooks as a failed Level A installation.

Do not hide hook failures merely because the hook bridge itself returns cleanly. scope-mcp hooks deliberately exit 0 on internal errors so a broken hook never blocks a session; verify the hook side effects (`hooks.log` lines, checkpoint rows, injected resume brief) instead.

## Doctor

`scope-mcp doctor` (MCP tool `doctor`, or CLI `node src/server.js --doctor`) prints a read-only environment diagnostic. It never writes and never changes configuration. Where reasonably detectable it reports:

* OS/platform
* Node executable
* Node version
* `node:sqlite` capability
* Harness home
* Harness version if discoverable
* profiles
* target profile
* MCP configuration presence
* hooks configuration presence
* skills roots
* scope-mcp skill discovery
* effective/project state path
* whether the project state directory is writable
* relevant sandbox/deployment-policy information when discoverable

Use it before and after installation changes; it is the quickest way to spot the Windows deployment-policy condition described above.

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
| `doctor` | Read-only environment diagnostic (platform, Node, node:sqlite, Harness, skills, hooks, state path, sandbox policy) |

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
node src/server.js --doctor
node src/server.js --db /other/project/.scope-mcp/state.db --status
sqlite3 .scope-mcp/state.db 'select id,status,title from goals;'
```

Status shows project/objective, scope status, goal counts and the current goal, validation evidence, coverage counts, completion timestamp, open blockers, recent decisions, and the last checkpoint's next action.

## Completion

Completing every goal is not completion. Before declaring done, the agent records coverage per scope requirement and calls `complete_project`, which reports unfulfilled requirements, unfinished goals, deferred items with reasons, open blockers, and the validation collected. Fix gaps, or pass `force: true` when a deferral is intentional, then complete.

## Cross-platform path correctness

Filesystem paths derived from file URLs must use Node-native conversion such as `fileURLToPath(...)`, never `url.pathname`, when the value is subsequently used as a native filesystem path. A URL `.pathname` is POSIX-shaped (`/C:/Users/...`) and Windows resolves it as `C:\C:\Users\...`.

Filesystem paths must be composed with Node's path utilities (`path.join`, `path.resolve`) where appropriate.

The following regression must remain impossible:

```text
/C:/Users/...
        ↓
C:\C:\Users\...
```

Regression tests cover native Windows drive-root behavior (`/^[A-Za-z]:[\\/]/`, no duplicated drive root) even when the suite executes on another OS.

## Testing and demo

```bash
npm test     # state, MCP round-trip, hook, doctor, and path-regression suites
npm run demo # SCOPE → goals → progress → checkpoint → resume (new process) → coverage → completion
```

Both are self-contained; the demo uses its own temporary database file. The path-regression suite also asserts that production files contain no developer-specific absolute paths, and that machine-specific fixtures (`scripts/hooks.json`, `scripts/probe-plugin.mjs`) are clearly marked as historical examples.
