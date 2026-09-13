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

if (argv.includes('doctor') || argv.includes('--doctor')) {
  const { doctorReport } = await import('./doctor.js');
  process.stdout.write(`${doctorReport()}\n`);
  process.exit(0);
}

const dbIndex = argv.indexOf('--db');
const dbPath = dbIndex !== -1 ? argv[dbIndex + 1] : undefined;

const { ProjectState, defaultDbPath } = await import('./state.js');
const { registerTools } = await import('./tools.js');

const store = new ProjectState(dbPath ?? defaultDbPath());

if (argv.includes('--status')) {
  process.stdout.write(`${store.statusText()}\n`);
  store.close();
  process.exit(0);
}

const hookIndex = argv.indexOf('hook');
if (hookIndex !== -1) {
  const { handleHook, readStdinPayload } = await import('./hooks.js');
  const payload = readStdinPayload();
  const out = handleHook(argv[hookIndex + 1] ?? payload.hook_event_name ?? 'stop', store, payload);
  if (out) process.stdout.write(`${out}\n`);
  store.close();
  process.exit(0);
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

registerTools(server, store);

await server.connect(new StdioServerTransport());
