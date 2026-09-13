/**
 * End-to-end demonstration: SCOPE -> generated goals -> execution progress ->
 * checkpoint -> resume (fresh process) -> scope coverage -> completion.
 *
 * Run with: npm run demo
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const SERVER = new URL('../src/server.js', import.meta.url).pathname;
// Honor SCOPE_MCP_DB when set, otherwise keep the demo self-contained in a temp dir.
const dbPath = process.env.SCOPE_MCP_DB ?? join(mkdtempSync(join(tmpdir(), 'scope-mcp-demo-')), 'state.db');

async function context(label) {
  const client = new Client({ name: label, version: '0.0.0' });
  await client.connect(
    new StdioClientTransport({ command: process.execPath, args: ['--no-warnings', SERVER, '--db', dbPath] })
  );
  return client;
}

const call = async (client, name, args = {}) =>
  (await client.callTool({ name, arguments: args })).content.map((p) => p.text).join('\n');

function section(title) {
  console.log(`\n=== ${title} ===`);
}

// ---- context 1 -----------------------------------------------------------
const first = await context('context-1');
section('SCOPE -> accepted scope, initialized project');
console.log(await call(first, 'init_project', { objective: 'Build scope-mcp: durable scope-driven project state over stdio.' }));

section('generated goals');
console.log(
  await call(first, 'set_goals', {
    goals: [
      { id: 'g1', title: 'SQLite state layer with deterministic transitions' },
      { id: 'g2', title: 'MCP tool surface over stdio' },
      { id: 'g3', title: 'tests + README' }
    ]
  })
);

section('execution progress');
console.log(`> ${await call(first, 'next_goal')}`);
console.log(await call(first, 'complete_goal', { goal_id: 'g1', validation: 'node --test: state tests pass' }));
await call(first, 'record_decision', { text: 'one sqlite file per workspace at .scope-mcp/state.db' });

section('checkpoint before compaction');
console.log(await call(first, 'checkpoint', { next_action: 'complete g2 (MCP tools), then g3' }));
await first.close();

// ---- context 2 (fresh process, knows nothing) ----------------------------
const second = await context('context-2');
section('resume from persisted state');
console.log(await call(second, 'status'));

section('continue working');
console.log(await call(second, 'complete_goal', { goal_id: 'g2', validation: 'mcp round-trip test passes' }));
console.log(await call(second, 'complete_goal', { goal_id: 'g3', validation: 'README + demo run clean' }));

section('scope coverage');
console.log(
  await call(second, 'coverage', {
    items: [
      { requirement: 'state survives restart', status: 'fulfilled', note: 'sqlite file + reload tests' },
      { requirement: 'checkpoint/resume', status: 'fulfilled', note: 'checkpoint + status tools' },
      { requirement: 'coverage check before completion', status: 'fulfilled', note: 'coverage + complete_project' },
      { requirement: 'http transport', status: 'deferred', note: 'stdio covers the need' }
    ]
  })
);

section('completion');
console.log(await call(second, 'complete_project'));
console.log(`\nfinal status: ${await call(second, 'status')}`);
await second.close();

console.log(`\ndemo state file: ${dbPath}`);
