#!/usr/bin/env node
/**
 * scope-mcp - tiny local MCP server for durable scope-driven project state.
 *
 * Transport: stdio. State: one SQLite file inside the workspace
 * (.scope-mcp/state.db, override with SCOPE_MCP_DB or --db).
 */

// node:sqlite reports an ExperimentalWarning on stderr; keep logs quiet.
process.removeAllListeners('warning');

const HELP = `scope-mcp - local MCP server holding durable scope-driven project state

Usage:
  scope-mcp                       run the MCP server on stdio
  scope-mcp --status              print current project status and exit
  scope-mcp doctor                print read-only runtime/environment diagnostics
  scope-mcp hook <event>          run one Harness hook and exit:
                                  stop | session-start | prompt-submit
                                  stdin: the Harness hook payload (optional)
  scope-mcp --db <path>           use another state file (also: $SCOPE_MCP_DB)
  scope-mcp --help                this text

Automatic behaviour with the Harness hooks bridge: Stop writes a checkpoint,
SessionStart injects the resume brief so a fresh context continues on its own.
`;

const argv = process.argv.slice(2);

if (argv.includes('--help') || argv.includes('-h')) {
  process.stdout.write(HELP);
  process.exit(0);
}

{
  const { nodeTooOld } = await import('./runtime-check.js');
  const refusal = nodeTooOld(process.versions.node);
  if (refusal) {
    process.stderr.write(`${refusal}\n`);
    process.exit(1);
  }
}

if (argv.includes('doctor') || argv.includes('--doctor')) {
  const { doctorReport } = await import('./doctor.js');
  process.stdout.write(`${doctorReport()}\n`);
  process.exit(0);
}

const dbIndex = argv.indexOf('--db');
const dbPath = dbIndex !== -1 ? argv[dbIndex + 1] : undefined;
// An explicit state file (--db or $SCOPE_MCP_DB) is the caller's decision and is used as given.
const explicitDb = dbPath ?? process.env.SCOPE_MCP_DB;

const { ProjectState, defaultDbPath, hasScope } = await import('./state.js');
const { registerTools } = await import('./tools.js');
const { isAbsolute, join } = await import('node:path');

if (argv.includes('--status')) {
  if (!explicitDb && !hasScope(process.cwd())) {
    process.stdout.write(`no SCOPE.md in ${process.cwd()}: scope-mcp does not apply here\n`);
    process.exit(0);
  }
  const store = new ProjectState(explicitDb ?? defaultDbPath());
  process.stdout.write(`${store.statusText()}\n`);
  store.close();
  process.exit(0);
}

const hookIndex = argv.indexOf('hook');
if (hookIndex !== -1) {
  const { handleHook, isDelegatedChild, readStdinPayload } = await import('./hooks.js');
  const payload = readStdinPayload();
  const workspace = payload.cwd || process.cwd();
  // Outside a scoped repository, and inside delegated DSH children, the hooks do nothing:
  // no state file is created and nothing is injected.
  if (!explicitDb && (!hasScope(workspace) || isDelegatedChild(payload.session_id))) process.exit(0);
  const store = new ProjectState(explicitDb ?? defaultDbPath(workspace));
  const out = handleHook(argv[hookIndex + 1] ?? payload.hook_event_name ?? 'stop', store, payload);
  if (out) process.stdout.write(`${out}\n`);
  store.close();
  process.exit(0);
}

// MCP server. One process may serve many workspaces (DSH Web shares one server
// between all sessions), so each tool call may name its workspace; the state file
// is that workspace's own, and only a workspace with a SCOPE.md is served.
const requireWorkspace = process.env.SCOPE_MCP_REQUIRE_WORKSPACE === '1';
const stores = new Map();
function storeAt(path) {
  if (!stores.has(path)) stores.set(path, new ProjectState(path));
  return stores.get(path);
}
function resolveStore(workspace) {
  if (workspace) {
    if (!isAbsolute(workspace)) return { error: `workspace must be an absolute path, got "${workspace}"` };
    if (!hasScope(workspace)) return { error: `no SCOPE.md in ${workspace}: scope-mcp does not apply to this workspace` };
    return { store: storeAt(join(workspace, '.scope-mcp', 'state.db')) };
  }
  if (explicitDb) return { store: storeAt(explicitDb) };
  if (requireWorkspace) {
    return { error: 'workspace is required: pass the absolute path of the repository you work in (this scope-mcp server is shared between workspaces)' };
  }
  if (!hasScope(process.cwd())) return { error: `no SCOPE.md in ${process.cwd()}: scope-mcp does not apply here` };
  return { store: storeAt(defaultDbPath()) };
}

const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');

const server = new McpServer(
  { name: 'scope-mcp', version: '0.1.0' },
  {
    instructions:
      'scope-mcp stores durable project state only: objective, lightweight goals, decisions, blockers, checkpoints, coverage. Read SCOPE.md and call status first after a fresh context, then work goal by goal. The model does the reasoning.',
    capabilities: { tools: {} }
  }
);

registerTools(server, resolveStore);

await server.connect(new StdioServerTransport());
