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
  scope-mcp                  run the MCP server on stdio
  scope-mcp --status         print current project status and exit
  scope-mcp --doctor         print a read-only environment diagnostic and exit
  scope-mcp --checkpoint [next action]
                             snapshot the working position and exit
  scope-mcp --db <path>      use another state file (also: $SCOPE_MCP_DB)
  scope-mcp --help           this text
`;

const argv = process.argv.slice(2);

if (argv.includes('--help') || argv.includes('-h')) {
  process.stdout.write(HELP);
  process.exit(0);
}

const dbIndex = argv.indexOf('--db');
const dbPath = dbIndex !== -1 ? argv[dbIndex + 1] : undefined;

const { ProjectState, defaultDbPath } = await import('./state.js');
const { registerTools } = await import('./tools.js');
const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');

const store = new ProjectState(dbPath ?? defaultDbPath());

if (argv.includes('--status')) {
  process.stdout.write(`${store.statusText()}\n`);
  store.close();
  process.exit(0);
}

if (argv.includes('--doctor')) {
  const { doctorReport } = await import('./tools.js');
  process.stdout.write(`${doctorReport({ dbPath: dbPath ?? defaultDbPath() }).join('\n')}\n`);
  store.close();
  process.exit(0);
}

const checkpointIndex = argv.indexOf('--checkpoint');
if (checkpointIndex !== -1) {
  const nextAction = argv[checkpointIndex + 1] ?? '';
  const cp = store.checkpoint({ next_action: nextAction });
  const lines = [`checkpoint at ${cp.at}`];
  for (const [key, value] of Object.entries(cp.payload)) lines.push(`  ${key}: ${value || '(unset)'}`);
  process.stdout.write(`${lines.join('\n')}\n`);
  store.close();
  process.exit(0);
}

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
