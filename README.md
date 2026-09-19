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

## Two kinds of durable state

```text
PROJECT INTENT                      PROJECT EXECUTION

base scope                          goals + progress
+ accepted addenda, in order        decisions + blockers
= effective scope                   validation + checkpoints
                                    coverage + completion
```

Intent says what the project must satisfy. Execution says where the work currently is. Both live in one small SQLite file per workspace, so a completely fresh context recovers both without anyone re-pasting anything: `get_effective_scope` for intent, `status` for progress. Checkpoints stay in the execution column — they summarize the working position and do not copy scope text into it.

## Architecture

```
Repository (any location)
├── SCOPE.md              accepted scope, project contract (source of truth for intent; mirrored durably by record_scope)
├── hooks.json            Harness hook config: checkpoint on Stop, resume brief on SessionStart
├── skills/               two Harness skills: save-checkpoint, resume-work
├── src/, tests, docs     repository work (source of truth for implementation)
└── ...

Each project workspace        → <workspace>/.scope-mcp/state.db   (one small SQLite file per project)

DeepSeek Harness  → runtime, session, lifecycle hooks, skills, context compaction
Model             → understanding the scope, goals, planning, coding, validation
scope-mcp         → durable state + simple guardrails (stdio MCP server + hook commands)
```

Six parts:

| File | Role |
| --- | --- |
| `src/state.js` | SQLite schema, deterministic state transitions, human-readable status rendering, workspace state-path resolution |
| `src/tools.js` | MCP tool adapters: parse args, call state, return text |
| `src/hooks.js` | Harness hook handlers: automatic checkpoint on `Stop`, resume brief on `SessionStart`, once-per-session fallback on `UserPromptSubmit` |
| `src/doctor.js` | Read-only runtime diagnostics: runtime capability, resolved paths, discovered Harness roots and profiles |
| `src/server.js` | Entry point: stdio transport, plus `--status` / `doctor` / `hook <event>` / `--db` / `--help` CLI |
| `skills/*/SKILL.md` | Two Harness skills: `save-checkpoint`, `resume-work` (canonical source) |

Dependencies: `@modelcontextprotocol/sdk` (framing) and `zod` (its required peer). Storage uses Node's built-in `node:sqlite` — no DB server, no daemon. Transport is stdio: no HTTP service, no ports, no auth.

Platform rules the code follows: paths are built with `node:path` and `node:os` (`join`, `resolve`, `homedir`), never by string concatenation; the state file always follows the active workspace (`process.cwd()`, or `$SCOPE_MCP_DB`), never the repository location; the running Node binary (`process.execPath`) is the runtime. Harness itself resolves its home the same way (`$DSH_HOME`, else `<home>/.dsh`, with `~` and `~\` expansion), so scope-mcp matches that behaviour instead of hard-coding one layout.

## Capability-based support levels

Behaviour is chosen from what the installed Harness actually offers, not from a platform name. Inspect with `node src/server.js doctor` plus one Harness session.

| Level | Requires | What you get |
| --- | --- | --- |
| **A — Full integration** | stdio MCP + skills + lifecycle hooks with context injection | automatic checkpoint at turn boundaries, automatic resume brief in a fresh context, both skills, all tools |
| **B — Functional integration** | stdio MCP + skills, no usable lifecycle hooks | everything except automation: `Save checkpoint` / `Resume work` skills drive the same durable state |
| **C — MCP-only integration** | stdio MCP only, no discoverable skill root | the tools work; the agent must be told in its instructions to call `checkpoint` before stopping and `status` when it opens |
| Unsupported | no local MCP and no equivalent supported tool interface | nothing to attach to |

Level B and C are supported installations, not failures: the state model and every tool are identical, only the automatic injection is missing. Missing hooks degrade to explicit `checkpoint` / `status` calls — no polling, no watcher, no daemon, no external context monitor.

Both installation methods aim for the highest level the target Harness environment natively supports — A where hooks exist, B where only skills and MCP exist, C where only the MCP transport exists — and report which level was reached. Nothing is emulated to climb a level: no polling, no watcher, no daemon, no UI automation.

## Compatibility matrix

Validation column uses four labels: **Tested** (executed here, with the observed evidence in the row), **Inspected** (mechanism read from the installed harness, not executed), **Expected** (inferred from shared mechanisms, awaiting a run), **Unsupported** (minimum capability absent). Only rows with evidence are marked; each row states what was actually done.

| Harness environment | MCP | Skills | Auto checkpoint | Auto resume | Level | Validation |
| --- | --- | --- | --- | --- | --- | --- |
| Web profile, Harness 0.1.5-rc.1 | Yes | Yes | Yes | Yes | A | Tested: tools listed in a live session, `Stop` wrote a checkpoint, repeat run reported `checkpoint unchanged`, `SessionStart` returned the decoded brief, both skills discovered and loaded |
| Headless profile (`dsh --profile headless`), Harness 0.1.5-rc.1 | Yes | Yes | Yes | Yes | A | Tested: headless session used the MCP tools end to end in its own workspace, wrote a `Stop` checkpoint row and a `resume_brief_for` marker, and listed `save-checkpoint` / `resume-work` in its skill catalog |
| Windows Web profile, Harness 0.1.5-rc.1 | Yes | Yes | Yes | Yes | A | Tested: native Windows validation; built-in tools and MCP passed, `SessionStart` injected the resume brief, `PostToolUse` markers fired, `Stop` wrote/deduplicated checkpoints, and fresh-session resume restored the correct goal and next action. Level A currently requires the documented Windows deployment-policy workaround for session-less hooks. |
| Desktop application (Electron-managed profile) | Yes (same client plugin) | Yes (same loader) | Expected | Expected | A (expected) | Inspected: the CLI hands the `desktop` profile to the Electron application, which manages its own profile directory; same profile/patch and plugin mechanism, same plugin packages available. Not executed here — no Electron application present, so not marked Tested |
| Other profiles created under `$DSH_HOME/profiles` | depends on mounted rows | depends on mounted rows | depends | depends | detected per profile | Inspected: profile discovery is directory-based; run `doctor` and one session to classify |

The headless profile ships without an MCP client row, so Level A there needs the same two patch entries as Web (below). Where a profile lacks skills or hooks, the same installation converges to Level B/C without extra work.

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

## Requirements

- Node >= 22.5, for the built-in `node:sqlite`. No database server, no
  daemon, no port: the server speaks MCP over stdio and is started by the
  harness that declares it.
- A harness with a stdio MCP client: DeepSeek Harness (the installation
  below, with hooks and skills) or simple-harness (an `mcp_servers` entry,
  row 6 in the table — MCP only, no hooks).

### Ecosystem dependencies and installation order

**This repository is row 2.** It depends on nothing else here and holds no retrieval or knowledge function: it stores project state and nothing more.

The same table is in the README of each of the six repositories; it was
written from the code on 2026-09-19 and follows it. Install top to bottom: each row
needs only rows above it.

| # | Repository | Needs | Serves | Needed by |
|---|---|---|---|---|
| 0 | a model runtime (Ollama, FreeToken, llama.cpp, a cloud endpoint) | — | an OpenAI-compatible `/v1` endpoint | every harness |
| 1 | [simple-harness](https://github.com/svend-blip/simple-harness) | Go 1.27 to build; row 0 to run | the `simple-harness` command on `PATH` | FlowRunner steps that name it, DPMtF-WebUI roles launched through harness-allocator |
| 2 | [scope-mcp](https://github.com/svend-blip/scope-mcp) | Node >= 22.5 (built-in `node:sqlite`) | a stdio MCP server; state in `<workspace>/.scope-mcp/state.db` | any harness that declares it (row 6) |
| 3 | [knowledge-service](https://github.com/svend-blip/knowledge-service) | Python >= 3.11; provider `leann`: a CUDA GPU with ~2.5 GB free VRAM; provider `portable`: CPU only | `http://127.0.0.1:9140/v1` — retrieval over LEANN indexes | mcp-light (four `knowledge_*` tools), DPMtF-WebUI (service mode) |
| 4 | [DPMtF-WebUI](https://github.com/svend-blip/DPMtF-WebUI) | Python 3.10+, tmux, git; [model-allocator](https://github.com/svend-blip/model-allocator) and [harness-allocator](https://github.com/svend-blip/harness-allocator) beside it; a harness on `PATH` (row 1); row 3 optional | `:9130`, the governance templates, BridgeV002, `DPMtF-WebUI/databases/dpmtf.db` | mcp-light (reads its files and database) |
| 5 | [mcp-light](https://github.com/svend-blip/mcp-light) | Python 3.8+, `mcp[cli]`; read access to the DPMtF-WebUI checkout and database (row 4) and to `model-allocator/allocator.db`; row 3 for the knowledge tools | `http://127.0.0.1:9135/mcp` — read-only MCP context server | any harness that declares it (row 6) |
| 6 | harness wiring | rows 1, 2, 5 | `~/.simple-harness/config.json` with an `mcp_servers` entry per server | every simple-harness run on the machine, whoever launched it |
| 7 | [FlowRunner](https://github.com/svend-blip/FlowRunner) | Go 1.27 to build; at run time, every harness a FlowApp's steps name, on `PATH` (row 1 for `simple-harness`) | the `flowrunner` command and desktop app | — |

Rows 1, 2 and 3 depend on nothing else in the table and can be installed
in any order. knowledge-service's one-time `import-registry` step reads
the DPMtF-WebUI database, so run that step after row 4; the service itself
does not need DPMtF-WebUI at run time.

#### Row 6: what wires a harness to the servers

simple-harness takes its MCP servers from its own configuration:
`~/.simple-harness/config.json`, then the nearest
`.simple-harness/config.json` at or above its working directory, then the
file `SIMPLE_HARNESS_CONFIG_FILE` names. A later file replaces an earlier
one's `mcp_servers` whole. FlowRunner writes that last file for a FlowApp
that declares `mcp_servers` (see below); DPMtF-WebUI's BridgeV002 writes
none, so its roles get what the machine's own files declare:

```json
{
  "mcp_servers": [
    { "name": "mcp-light", "transport": "http",
      "endpoint": "http://127.0.0.1:9135/mcp", "permission": "read_only",
      "allowlist": ["get_governance_index", "get_governance_file",
                    "knowledge_search", "knowledge_scopes",
                    "knowledge_learning", "knowledge_retrievals"] },
    { "name": "scope-mcp", "transport": "stdio",
      "command": ["node", "/abs/path/to/scope-mcp/src/server.js"],
      "permission": "workspace_write" }
  ]
}
```

Without the `knowledge_*` names in the allowlist an agent has no
retrieval. Without the scope-mcp entry it has no durable project state:
no simple-harness configuration declares scope-mcp unless you add it. A
stdio server is started in the workspace, so scope-mcp keeps its state
with the project.

#### How LEANN retrieval reaches an agent

```text
model in a harness
  -> the harness's MCP client              (mcp_servers, row 6)
  -> mcp-light          :9135/mcp          knowledge_search / _scopes / _learning / _retrievals
  -> knowledge-service  :9140/v1           /v1/search, /v1/scopes, /v1/learning, /v1/retrievals
  -> LEANN (hnsw, CUDA)  or the portable CPU provider
```

LEANN lives in knowledge-service and nowhere else. mcp-light is its only
MCP face. scope-mcp has no retrieval of any kind, and simple-harness has
none of its own: it is a generic MCP client that also fills in `run_id`,
`handoff_id` and `flow_key` on MCP calls from `SIMPLE_HARNESS_RUN_ID`,
`SIMPLE_HARNESS_HANDOFF_ID` and `SIMPLE_HARNESS_FLOW_KEY`, so that a
retrieval can be attributed to the run that made it.

#### What is and is not automatic

- FlowRunner has no default harness: every step of a FlowApp names one,
  and an empty `harness:` fails validation. A step that names
  `simple-harness` gets whatever `simple-harness` resolves to on `PATH`
  at dispatch — so a rebuilt simple-harness is used by the next run with
  no change to FlowRunner. The Windows bundle carries its own
  `simple-harness.exe`; `scripts/build-windows-bundle.sh` in FlowRunner
  builds the three programs together and stamps the commits into
  `BUILD-INFO.txt`.
- A FlowApp declares its MCP servers (`mcp_servers:` in `app.yaml`:
  `endpoint_env` for an http server, a `command` with `${VAR}` references
  for a stdio one). FlowRunner's preflight connects to each — a real MCP
  handshake and tool listing — and the run is handed exactly those servers
  through `SIMPLE_HARNESS_CONFIG_FILE`, written under FlowRunner's runtime
  root, never into the workspace. `flowrunner mcp <flowapp-id>` and the
  desktop's green pills show which declared servers FlowRunner is
  connected to. A FlowApp that declares none leaves simple-harness with
  the machine's `~/.simple-harness/config.json`, as before: on a machine
  without that file such a FlowApp runs with no MCP server at all.
- A FlowApp's `knowledge:` block reaches a harness as
  `KNOWLEDGE_PROVIDERS` and `KNOWLEDGE_<NAME>_URL`. simple-harness does not
  read them: for a simple-harness step retrieval comes through an MCP
  server that offers `knowledge_search` (mcp-light does), and FlowRunner's
  preflight refuses a FlowApp that enables knowledge, runs simple-harness
  steps and declares no such server, instead of letting it run and
  retrieve nothing.
- Both launchers set the three position variables. FlowRunner sets them
  from the family run number, the handoff cycle and the FlowApp id.
  BridgeV002's role terminal sets them per delivered prompt — a pane
  outlives its handoffs — from the flow key, the run the chain is
  executing and the handoff id field of the prompt; what it does not know
  it does not set.
## Installation

Two supported methods. Both end at the same place: scope-mcp running at the highest integration level the target Harness environment natively supports, with project state in `<workspace>/.scope-mcp/state.db`. Neither method assumes Linux, `/home/<user>`, `/usr/bin/node`, the `web` profile, a fixed skill root, or symlink support — those are detected.

1. **[AI-assisted installation](#ai-assisted-installation)** — recommended.
2. **[Manual installation](#manual-installation)** — for configuring Harness by hand.

The support level a target reaches is decided by detected capabilities, not by which product it is. See [Capability-based support levels](#capability-based-support-levels) and the [compatibility matrix](#compatibility-matrix) above for what has actually been observed.

## AI-assisted installation

Recommended method, and the shortest one. Let an AI agent with access to the existing DeepSeek Harness installation do the detecting, merging and validating. The repository can live anywhere; nothing depends on a particular home directory or shell.

The installing agent detects, in order:

* the operating system and its path rules
* the installed DeepSeek Harness version (from the installed harness package, not assumed)
* the profile or distribution actually in use, or the ones named by the user
* a Node runtime that provides `node:sqlite`, resolved to an absolute path
* MCP support in that profile (which client plugin is mounted, which transports it accepts)
* hooks support (whether the lifecycle-hooks bridge is available and which events it emits)
* which skill roots that installation actually scans
* the repository's absolute path, so generated configuration points at the real location

It then preserves existing configuration, merges only what is missing, installs at the highest supported level (A, then B, then C), and validates each stage. The detailed procedure is the [AI Installation Instruction](#ai-installation-instruction) below.

```text
git clone <scope-mcp repository>
cd scope-mcp
```

Then open that directory with an AI agent that can reach the existing Harness installation, and say:

```text
Follow the AI Installation Instruction in README.md and install scope-mcp,
its hooks, and its global skills into this DeepSeek Harness installation.
Preserve my existing configuration and validate the installation.
```

Optionally name the targets: *"Install scope-mcp for Desktop."* or *"Install scope-mcp for Web and headless."* Profiles that are not named stay untouched.

## Manual installation

For configuring DeepSeek Harness directly. Same result, same capability checks — the difference is only who performs them. Do not assume Linux, `/usr/bin/node`, the `web` profile, `~/.agents/skills`, one fixed `$DSH_HOME`, or that symlinks work.

### Step A — Verify the runtime

A Node runtime with built-in `node:sqlite` is required: **Node >= 22.5**. Any installation mechanism counts (version manager, distribution package, vendor runtime). An interactive shell's `node` is not necessarily the runtime a hook or service host will use, so check the exact executable you plan to write into configuration:

```bash
node --version
node -e "import('node:sqlite').then(m=>console.log(m.DatabaseSync? 'sqlite ok':'no sqlite'))"
```

Print the absolute path of the runtime that passed and use that path everywhere below.

### Step B — Install dependencies and check the repository

From the cloned repository:

```bash
npm install            # read-only npm cache: npm_config_cache=./.npm-cache npm install
npm test
npm run demo
node src/server.js doctor
```

`doctor` is read-only apart from ensuring its own state directory. It reports the version, Node runtime and `node:sqlite` availability, repository path, active workspace, resolved state path and write capability, discovered Harness home and profiles, discovered skill roots, and the Harness environment variables in view. Run it from the project workspace you intend to use, and again later from any other workspace — the state path should follow that workspace.

### Step C — Detect the Harness home and profile

Harness keeps its home under `$DSH_HOME`, falling back to `.dsh` in the user home, and discovers profiles as directories beneath `profiles/`:

```bash
node src/server.js doctor      # harness home, discovered profiles, skill roots
ls "$DSH_HOME/profiles"        # or the equivalent for your shell
```

Choose the profile that is actually used — the one the session launches with, or the one the user named. Do not default to `web` just because it exists, and leave unused profiles alone. Composed rows for a profile can be inspected with:

```bash
dsh --profile <name> --dump-config
```

The profile's editable layer is `<profile>/cordis.patch.yml` inside that directory. Copy it to a timestamped backup before editing.

### Step D — Make sure an MCP client is available

If the selected profile already mounts the native MCP client, reuse it. Otherwise add a compatible version at the harness's own version:

```bash
dsh plugin --profile <name> add '@deepseek-ai/dsh-mcp-client@<installed harness version>'
```

### Step E — Configure the scope-mcp MCP server

The shape scope-mcp needs is the same everywhere; the surrounding profile syntax belongs to Harness and may differ by version, so check what the installed version documents and accepts rather than copying a fixed wrapper:

```yaml
serverName: scope-mcp
transport: stdio
command: <absolute compatible Node executable>
args:
  - <absolute path to scope-mcp/src/server.js>
```

Omit `cwd` to let each session keep its launch directory as its workspace; set it only when the profile always serves one project. For a session-level configuration instead of a profile, see [Connect it to DeepSeek Harness](#connect-it-to-deepseek-harness).

Labeled example for the tested Harness 0.1.5-rc.1 `web` and `headless` profiles, appended to that profile's `cordis.patch.yml`:

```yaml
- insert:
    - id: mcp-scope-mcp
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: scope-mcp
        transport: stdio
        command: /absolute/path/to/node-with-node-sqlite
        args: [/absolute/path/to/scope-mcp/src/server.js]
        env: {}
        toolCallTimeoutMs: 60000
        failOnStartupError: true
```

### Step F — Configure hooks where supported

Full Level A integration uses the repository's [`hooks.json`](hooks.json) for automatic turn-boundary checkpointing (`Stop`) and automatic fresh-session resume injection (`SessionStart`, with a once-per-session `UserPromptSubmit` fallback). Where the profile exposes the hooks bridge, mount it and point it at that file, giving it the repository path so `${CLAUDE_PLUGIN_ROOT}` resolves:

```yaml
- insert:
    - id: hooks-scope-mcp
      name: '@deepseek-ai/dsh-hooks-claude-code'
      config:
        configPath: /absolute/path/to/scope-mcp/hooks.json
        pluginRoot: /absolute/path/to/scope-mcp
```

(Again the tested 0.1.5-rc.1 shape; confirm the bridge package name and options for the installed version.) Where no hooks mechanism is available, stop here — scope-mcp still works at Level B with manual `Save checkpoint` / `Resume work`, and nothing else changes.

### Step G — Install the two global skills

Install `save-checkpoint` and `resume-work` from the repository's `skills/` directory into a root that this installation actually scans (`doctor` lists the existing candidates; confirm against skills already visible in a session). The repository copies stay canonical — edits there are what matter. Prefer a native reference/link mechanism, then a symlink or junction; where none of those behave well, copy the directories and note that each change needs a re-copy. Names stay lowercase with hyphens. Keep project state out of global roots.

### Step H — Validate

* Harness starts with the profile in use and the session shows the scope-mcp tools.
* `status` answers and shows the scope-document counts.
* `Save checkpoint` and `Resume work` appear in the skill catalog.
* Ending a turn writes one checkpoint, and ending it again without changes does not add a second row; a fresh session receives the resume brief (where hooks are supported — otherwise confirm `checkpoint` + `status` round-trip across two sessions).
* Two different workspaces produce two different `<workspace>/.scope-mcp/state.db` files.

Then continue with [Quick start after installation](#quick-start-after-installation) — the same first-use flow regardless of which method was used.

### Windows PowerShell example

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

## Connect it to DeepSeek Harness

Register it as a stdio MCP server for the session. Harness requires an absolute `command` path:

```jsonc
{
  "mcpServers": [
    {
      "name": "scope-mcp",
      "command": "/absolute/path/to/a/node-with-node-sqlite",
      "args": ["/absolute/path/to/scope-mcp/src/server.js"],
      "env": [{ "name": "SCOPE_MCP_DB", "value": "/absolute/path/to/project/.scope-mcp/state.db" }]
    }
  ]
}
```

Harness accepts two MCP transports: omit `type` for stdio (shown above), or `{ "type": "http", "url": "..." }` for Streamable HTTP. Stay on stdio unless the target genuinely lacks it — an HTTP server would only add a listening process for no benefit. `command` must be an absolute path, and `env` / `headers` are ordered `{ "name", "value" }` entries rather than plain maps.

`SCOPE_MCP_DB` is optional. Without it the state file is `<cwd>/.scope-mcp/state.db`, which is what you want when the agent runs in the project workspace; a leading `~` expands against the platform home. Setting it explicitly is for one fixed shared workspace.

Note for programmatic clients: call tools with the object form `callTool({ name, arguments })`. Some SDK client builds treat the two-positional-argument shorthand inconsistently.

Both blocks are the same server: the JSON above registers it for one session, and [Harness configuration required](#harness-configuration-required) shows the profile-level YAML that mounts it permanently together with the hook row that makes checkpointing automatic.

## Automatic checkpoint and resume

Both directions work without anyone asking for them.

**Automatic checkpoint.** Harness runs [`hooks.json`](hooks.json) through its hooks bridge. At each turn boundary (`Stop`) the bridge executes `scope-mcp hook stop`, which writes one checkpoint: current goal, work completed, validation state, important decisions, unresolved issues, and the exact next action. Fields that are not passed in are derived from stored state, so an unattended checkpoint is still complete. Writing stays cheap: an unchanged snapshot reuses the previous row, an empty store writes nothing at all, and only the newest 50 rows are kept. An ordinary short session ends with one or two checkpoints, not one per message.

**Automatic resume.** `SessionStart` runs `scope-mcp hook session-start`. The command replies in the shape Harness decodes — `hookSpecificOutput.additionalContext` — so the resume brief (objective, current goal, exact next action, completed work with its validation, open blockers, checkpoint time) is injected into the new context as it opens, and the agent continues from the recorded next action on its own. `UserPromptSubmit` carries the same brief for a context that opened without a `SessionStart` hook; it injects once per session id and stays silent afterwards, so it does not repeat on every prompt.

Explicit calls still win: `checkpoint { "next_action": "..." }` records a precise instruction that automatic checkpoints keep while the same goal is active, then fall back to the active goal once work moves on.

The mapping — `Stop` → checkpoint, `SessionStart` → resume brief, `UserPromptSubmit` → once-per-session fallback — is the proven one. Where another Harness build names its equivalent events differently, point the same three commands at those events; the handlers do not care about the names.

### Harness configuration required

Both rows live in the patch layer of the profile that is actually used, `$DSH_HOME/profiles/<profile>/cordis.patch.yml`:

```yaml
- insert:
    - id: mcp-scope-mcp
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: scope-mcp
        transport: stdio
        command: /absolute/path/to/node-with-node-sqlite
        args: [/absolute/path/to/scope-mcp/src/server.js]
        env: {}
    - id: hooks-scope-mcp
      name: '@deepseek-ai/dsh-hooks-claude-code'
      config:
        configPath: /absolute/path/to/scope-mcp/hooks.json
        pluginRoot: /absolute/path/to/scope-mcp
```

Use the repository's real absolute path in all three places; `${CLAUDE_PLUGIN_ROOT}` in `hooks.json` resolves from `pluginRoot`, so the same file works wherever the repository is cloned. Moving the repository afterwards means updating these paths (or re-running installation) — say so rather than hiding it.

Omit `cwd` to let each session keep its launch directory as its workspace. Set `cwd` only when this profile always serves one project. Different profiles are patched independently; a profile you do not use needs no change.

`patchReload: live` picks patches up without a restart; other profiles need a new session. If a plugin package is missing from that profile: `dsh plugin --profile <profile> add '@deepseek-ai/dsh-hooks-claude-code'`.

Hook commands run with cwd set to the session workspace and `CLAUDE_PROJECT_DIR` exported, so state lands in `<workspace>/.scope-mcp/state.db` unless `SCOPE_MCP_DB` says otherwise. Keep the paths absolute; hooks run non-interactively and do not inherit shell aliases. Verify without opening a session:

```bash
node src/server.js hook stop           # writes the checkpoint, prints one line
node src/server.js hook session-start  # prints the JSON block a fresh context receives
node src/server.js --status            # full working position
```

### Limitations in this Harness version (0.1.5-rc.1)

* There is **no dedicated pre-compaction event**: automatic compaction runs inside the agent loop (context pressure at the step boundary, plus context-overflow recovery) and fires no hook event of its own. Checkpointing at every turn boundary covers it — durable state is at most one turn old when compaction runs — and `/compact` keeps its own summary next to it. If a later version exposes a real pre-compaction event, point the checkpoint command at it and keep this mapping as the fallback.
* Only `SessionStart`, `UserPromptSubmit` and `PostToolUse` surface a hook's `additionalContext`; a `Stop` hook contributes state through its side effect only. Top-level `systemMessage` and `updatedInput` are ignored by the bridge today.
* Compaction itself stays entirely inside Harness. `scope-mcp` never stores conversation history: the SQLite file holds goals, validation, decisions, blockers, checkpoints and coverage.
* Neither shipped profile mounts the hooks bridge by default, so its row is added once per profile in use. Without it, everything still works through explicit tool calls — Level B.
* Harness keeps one MCP server process per running session. After updating this repository, restart the session (or the MCP connection) so the server reloads; otherwise the running session talks to the previous build and may not see newly added tools. Skills and hook commands are re-read per run, so they pick up changes immediately.
* Skill names must be lowercase with hyphens (`^[a-z0-9]+(?:-[a-z0-9]+)*$`); other names are skipped by the loader. Roots are scanned in this order: `<projectRoot>/.dsh/skills`, `<projectRoot>/.agents/skills`, configured extra directories, `$DSH_HOME/skills`, `<agents home>/skills`, each with an optional `skills/` layer. Linked skill directories are followed. `doctor` lists which of these exist right now.

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

### Windows Level A installation validation

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

## AI Installation Instruction

Read and execute this section in order. It is the detailed guide behind [AI-assisted installation](#ai-assisted-installation); the same stages appear there in short form for anyone configuring Harness by hand. It installs the complete package into a running DeepSeek Harness installation, merges rather than replaces, and validates each stage. Paths and versions are examples: detect real values first and use what the installed version supports. Work with filesystem inspection, Node, and the Harness CLI — the steps are shell-agnostic (bash, zsh, and PowerShell all provide the same primitives), so do not assume one shell.

### 1. Detect capabilities, not machine names

```bash
node src/server.js doctor        # one report: runtime, paths, harness home, profiles, skill roots
```

Then confirm what Harness itself exposes:

```bash
echo "$DSH_HOME"                                  # harness home; falls back to the default under the user home
ls "$DSH_HOME/profiles"                           # available profiles
cat "$DSH_HOME/settings.yaml"                     # default model/provider rows to preserve
cat "$DSH_HOME/profiles/<profile>/package.json"    # bundles + harness version in use
dsh --profile <profile> --dump-config              # composed plugin rows for that profile
```

Record, for the profile(s) in use: harness version (from the installed `@deepseek-ai/dsh` package.json), whether the MCP client plugin and hooks bridge are mounted (`--dump-config` / existing patch rows), which skill roots exist and are actually scanned (check `doctor`, then confirm in a session), and how the profile names its session-start and turn-boundary events. Do not infer one profile's contents from another, and do not assume a distribution is weaker or stronger than it is.

Choose the target profiles deliberately: use what the user named, otherwise the profile the current session runs in. Profiles that are not in use stay untouched.

### 2. Pick a Node runtime

`node` in an interactive shell is not necessarily the runtime a hook or service manager will use. List candidates (`process.execPath` of the current session, the distribution's node, any version-manager current), then verify each candidate:

```bash
<AbsolutePathToNode> -e "import('node:sqlite').then(m=>console.log(m.DatabaseSync? 'sqlite ok':'no sqlite'))"
```

Take the first candidate that prints `sqlite ok` and resolve it to an absolute path. Use exactly that path in every Harness configuration entry. Do not require nvm and do not prefer `/usr/bin/node`: on this class of machine the distribution node can be older than the `node:sqlite` floor while the active session runs a newer runtime.

### 3. Install dependencies and check the repository

```bash
cd <path/to/scope-mcp>
npm install          # read-only npm cache: npm_config_cache=./.npm-cache npm install
npm test
npm run demo
```

Keep dependencies as they are: `@modelcontextprotocol/sdk` plus `zod`, storage through built-in `node:sqlite`. No daemon, scheduler, polling, or service.

### 4. Merge the MCP row (idempotent)

Read the target profile's existing patch file first. If it already contains an `mcp-scope-mcp` row, update that row in place rather than appending another. Otherwise back up the file and append one entry, leaving every existing entry intact:

```bash
# from the profile directory: copy cordis.patch.yml to cordis.patch.yml.bak-<timestamp>
```

```yaml
- insert:
    - id: mcp-scope-mcp
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: scope-mcp
        transport: stdio
        command: /absolute/path/to/a/node-that-supports-node-sqlite
        args: [/absolute/path/to/scope-mcp/src/server.js]
        env: {}
        toolCallTimeoutMs: 60000
        failOnStartupError: true
```

If the installed version exposes MCP servers through a different structure (for example an ACP `mcpServers` block with ordered `env` entries), use that structure with the same values instead. Add the client package only when it is missing: `dsh plugin --profile <profile> add '@deepseek-ai/dsh-mcp-client@<installed harness version>'`.

### 5. Merge the hooks row (skip where hooks are unavailable)

Same file, same idempotent rule — update `hooks-scope-mcp` if present, else append:

```yaml
- insert:
    - id: hooks-scope-mcp
      name: '@deepseek-ai/dsh-hooks-claude-code'
      config:
        configPath: /absolute/path/to/scope-mcp/hooks.json
        pluginRoot: /absolute/path/to/scope-mcp
```

`pluginRoot` supplies `${CLAUDE_PLUGIN_ROOT}` used inside `hooks.json`, which is how the package path stays independent of the active workspace. Where the profile already ships a hook mechanism, reuse it with the same three commands (`hook session-start`, `hook prompt-submit`, `hook stop`) instead of adding a second one. Where the profile has no hook mechanism at all, stop here: the installation is still supported at Level B.

### 6. Install the two skills

Discover the scanned skill roots (`doctor` lists the ones that exist; confirm against skills already visible in a session). Match the format already working there — `<dir>/SKILL.md` with frontmatter `name` and `description`, lowercase-hyphen names. Then install both repository skills into one root that is actually scanned, preferring in order: Harness's own reference/link mechanism if it has one, a symlink or junction, and finally a copied directory.

* Symlinked roots keep the repository canonical, and edits apply on the next read.
* Copied directories need a re-copy after every skill change — say which one was used.
* Keep project state out of global roots: state stays in `<workspace>/.scope-mcp/state.db`.

Names must stay `save-checkpoint` and `resume-work`.

### 7. Validate

```bash
node src/server.js doctor
node src/server.js --help
echo '{"hook_event_name":"Stop"}' | node src/server.js hook stop
echo '{"hook_event_name":"SessionStart","session_id":"v1"}' | node src/server.js hook session-start
```

Then, inside Harness in the target profile:

- the session lists the scope-mcp tools (`init_project`, `status`, `set_goals`, `next_goal`, `complete_goal`, `record_decision`, `record_blocker`, `resolve_blocker`, `checkpoint`, `coverage`, `complete_project`, plus `record_scope`, `add_scope_addendum`, `get_effective_scope`);
- `status` answers and shows the scope-document counts and the effective-scope line;
- durable scope works end to end in a disposable directory: `record_scope` a short base, `add_scope_addendum` one addition, start a second process, and confirm `get_effective_scope` returns both in order without anything being re-supplied;
- ending a turn writes one checkpoint, and ending it again without changes does not add a second row;
- a fresh session receives the resume brief with current goal and next action, and the brief points at `get_effective_scope`;
- both skills appear in the skill catalog and load;
- two different workspaces create two different `.scope-mcp/state.db` files.

Where a capability is absent, verify the level it degrades to instead: without hooks, `checkpoint` + `status` must still round-trip across sessions; without skills, the same calls must work from the agent's own instructions.

End-to-end, in a throwaway directory: start a session there, give it a three-line scope, let it record scope + goals + partial progress, say **"Save checkpoint"**, close the session, open a new one, say **"Resume work"**, and confirm the agent names the correct goal, validation evidence, and next action without being told anything. Then add a one-line addendum in that second session and confirm the agent reads the effective scope, keeps the completed work, and continues with the new requirement. Delete only that temporary directory when done.

### 8. Report

Report concisely: harness version, harness home, profiles modified, Node executable used, repository path, MCP/hook rows installed, skill root and install method, validation results per capability, the support level reached, the end-to-end resume result, and remaining limitations. Re-running installation should converge: report what was already present instead of duplicating it.

### Uninstall

Remove only scope-mcp's own parts:

1. Delete the `mcp-scope-mcp` and `hooks-scope-mcp` entries from the patched profile(s), or restore the timestamped backup of that patch file.
2. Remove the two skill entries (`save-checkpoint`, `resume-work`) from the skill root they were installed in.
3. Leave everything else alone: other profiles, unrelated plugins, credentials, unrelated skills, Harness session storage.

Project state is deliberately not removed by uninstall: `<workspace>/.scope-mcp/state.db` is durable project data, deleted only when the user asks for it per project.

## Normal usage

### Quick start after installation

Identical after either installation method.

```text
Open DeepSeek Harness in the project workspace.
Paste the project scope.
Answer only necessary clarification questions.
Let Harness continue autonomously.
```

```text
Save checkpoint     # pause with the working position stored
Resume work         # a later or fresh context picks it up
```

Project state stays local to the workspace, one file per project:

```text
<workspace>/.scope-mcp/state.db
```

### Start a project

Paste the scope (or keep it in `SCOPE.md`) and say *"Here is the scope. Ask anything essential, then build it."* The agent clarifies only what is genuinely unclear, persists the accepted text with `record_scope`, derives goals, and works them autonomously. The pasted text does not need to be provided again — it is durable intent from that point on.

### Extend a project later

Hand over the new text as a scope addendum. The agent stores it with `add_scope_addendum`, reads the effective scope, keeps the goals that still apply, adds what the new requirement needs, and continues. A project that was already complete is reopened for re-evaluation by that same act.

### Pause

Say **"Save checkpoint"**. The `save-checkpoint` skill records what changed and the exact next action. Scope documents are not copied into checkpoints.

### Cold resume

Say **"Resume work"** after a restart, compaction, or a new session. The `resume-work` skill reads the effective scope first, then the execution state, checks the repository, reconciles, and continues from the recorded next action — no re-explaining. With hooks configured, the small resume brief already arrives with the new context: current goal, progress, blockers, next action, plus a pointer to fetch the effective scope. Automatic hooks keep checkpointing at every turn boundary in the background.

## Start a new scope-driven project

1. Put the accepted scope in `SCOPE.md` in the workspace (or paste it and have the agent write it).
2. Answer the agent's essential clarification questions once. The clarifications become decisions, and the scope is then stable intent.
3. Say something like: *"Here is the scope. Ask anything essential, then build it."*

The agent then loops autonomously:

```
read effective scope → status → next_goal → work → validate → complete_goal
                     → record_decision / record_blocker → continue
                     → coverage → complete_project
```

Typical calls:

```jsonc
init_project   { "objective": "Build scope-mcp: durable scope-driven project state.", "scope_file": "SCOPE.md" }
record_scope   { "text": "...accepted scope...", "title": "base" }
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
| `record_scope` | Persist the accepted base scope as durable intent |
| `add_scope_addendum` | Append one accepted addendum after the base, in order |
| `get_effective_scope` | Base + active addenda in order, with acceptance timestamps; `include_text: false` returns the document index only |
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

## Durable scope: base plus ordered addenda

Accepted intent is stored inside scope-mcp (table `scope_docs`), so a restart never needs the scope pasted again:

| Column | Meaning |
| --- | --- |
| `seq` | acceptance order — base first, then its addenda |
| `kind` | `base` or `addendum` |
| `at` | acceptance timestamp |
| `title` | optional short label |
| `text` | the accepted scope text |
| `active` | `1` for the current chain; superseded records are kept, not deleted |

* `record_scope` stores the accepted base scope. Recording a later base supersedes the previous chain: old rows stay for history, marked inactive.
* `add_scope_addendum` appends one accepted addendum after the base, in recorded order. An addendum needs a base to attach to.
* `get_effective_scope` returns the base plus its active addenda in order, each labelled `[#seq] kind accepted <timestamp> - title`. That is the document to reconcile goals and coverage against. With a large scope, `include_text: false` returns just that index — sequence, kind, acceptance stamp, length — so provenance can be checked without pulling every document into context.
* `status` prints counts (`scope documents: base recorded, addenda: N | effective revision: #M`), a one-line effective-scope summary, and the ordered list — never the whole documents. The injected resume brief carries the same summary plus a pointer to `get_effective_scope`.
* `init_project` with `reset: true` clears tracked work but keeps accepted scope documents — intent outlives a reset.

### Scope intake, addenda, and completion

Text handed over as the project scope becomes the base scope (`record_scope`) when none is recorded yet; text handed over as an addition or modification becomes an ordered addendum (`add_scope_addendum`). Nothing else needs to classify text, and the classification itself is the model's judgement, not server logic.

An addendum accepted after `complete_project` reopens the completion check on purpose: `scope_status` goes back to `accepted`, the stale completion stamp is cleared, completed goals and valid coverage stay exactly as they are. Then the new requirements are evaluated — add goals with `set_goals` (completed ones are preserved), record coverage for the new requirements, and call `complete_project` again. Coverage recorded before the newest scope document counts as needing a fresh look, so completion waits until coverage has been reconsidered against the current effective scope. Nothing is marked fulfilled automatically.

### Relationship to SCOPE.md

`SCOPE.md` in the repository stays the human-readable artifact of the contract, and the two should agree. The recorded scope documents inside `scope-mcp` are what a fresh context reads first, because they survive in one place with their order and timestamps. Updating `SCOPE.md` when accepting scope or an addendum is a normal edit by the model — there is no file watcher and no synchronization machinery.

### Existing projects

A database written before scope documents existed keeps working untouched: opening it adds the missing `scope_docs` table, all goals, decisions, blockers, coverage and checkpoints stay, and `status` reports that no base scope is recorded yet (`read SCOPE.md`). Recording it then is a plain `record_scope` call — import from `SCOPE.md` when it clearly holds the accepted scope, otherwise record what the user accepts now. Nothing is invented for the past.

Interpretation stays with the model. scope-mcp only persists ordered scope documents and hands back the effective view; reconciling base against addenda, keeping already completed valid work, and adding or adjusting goals where the effective scope requires it is the agent's job.

## State, checkpoint, resume

```
WORK → turn boundary → checkpoint written → compaction/reset → brief injected → effective scope read → goals reconciled → WORK
```

* `checkpoint` writes one row containing the current goal, work completed, important decisions, validation state, unresolved issues, and the next action. Anything you omit is filled from stored state, so `checkpoint {"next_action": "..."}` is usually enough. Keep it short — summaries, not transcripts. Harness hooks call the same path automatically (see [Automatic checkpoint and resume](#automatic-checkpoint-and-resume)).
* Conversation history is *not* stored here. Harness owns session persistence and compaction; the repository is memory.
* Recovery after Harness restart, MCP server restart, compaction, or a brand-new context is the same each time: the small resume brief arrives with the new context, then `get_effective_scope` restores intent, `status` restores the position, and the repository confirms the details. The SQLite file (WAL journal, `synchronous = FULL`) survives process death between statements.

With the hooks row configured, a fresh context already holds the goal and next action; the opening move is then `status` only when more detail is needed. Large scope documents stay on disk until something actually needs them — a brief, counts, and one call to fetch the text.

## Inspect current state

From inside a session: the `status` tool. From a shell:

```bash
node src/server.js doctor      # runtime, paths, discovered roots, recorded intent counts
node src/server.js --status
node src/server.js --db /other/project/.scope-mcp/state.db --status
sqlite3 .scope-mcp/state.db 'select id,status,title from goals;'
```

Status shows project/objective, scope status, scope-document counts and effective revision, goal counts and the current goal, validation evidence, coverage counts, completion timestamp, open blockers, recent decisions, ordered scope documents, and the last checkpoint's next action. Doctor additionally prints whether this workspace already has durable intent — initialized or not, base recorded or missing, number of addenda — without evaluating what any of it means.

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
npm test     # 54 tests: init, goal create/update/progression, checkpoints, reload-after-restart,
             # decisions, blockers, coverage, completion guardrails, MCP round-trips,
             # hook-driven checkpoint and fresh-context resume,
             # cold-start restore of base scope + addenda and goal reconciliation,
             # addendum reopening completion, coverage freshness, legacy migration,
             # skill metadata, workspace state isolation (including paths with spaces),
             # portable path/state resolution, doctor diagnostics,
             # package/hook/README consistency
npm run demo # SCOPE → goals → progress → checkpoint → resume (new process) → coverage → completion
```

Both are self-contained; the demo uses its own temporary database file.
