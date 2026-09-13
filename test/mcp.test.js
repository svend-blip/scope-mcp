import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const SERVER = new URL('../src/server.js', import.meta.url).pathname;

async function connect(dbPath) {
  const client = new Client({ name: 'scope-mcp-test', version: '0.0.0' });
  await client.connect(
    new StdioClientTransport({ command: process.execPath, args: ['--no-warnings', SERVER, '--db', dbPath] })
  );
  return client;
}

/** Call one tool and return its text output. */
async function call(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  return result.content.map((part) => part.text).join('\n');
}

function dbInTmp() {
  return join(mkdtempSync(join(tmpdir(), 'scope-mcp-mcp-')), 'state.db');
}

test('server exposes a small tool surface over stdio', async () => {
  const client = await connect(dbInTmp());
  const { tools } = await client.listTools();
  assert.deepEqual(
    tools.map((t) => t.name).sort(),
    [
      'add_scope_addendum',
      'checkpoint',
      'complete_goal',
      'complete_project',
      'coverage',
      'get_effective_scope',
      'init_project',
      'next_goal',
      'record_blocker',
      'record_decision',
      'record_scope',
      'resolve_blocker',
      'set_goals',
      'status'
    ]
  );
  assert.ok(tools.every((t) => (t.description ?? '').length > 10), 'every tool explains itself');
  await client.close();
});

test('scope -> goals -> progress -> checkpoint -> resume -> coverage -> completion', async () => {
  const dbPath = dbInTmp();
  const first = await connect(dbPath);

  assert.match(await call(first, 'init_project', { objective: 'Ship scope-mcp', scope_file: 'SCOPE.md' }), /objective: Ship scope-mcp/);

  const goals = await call(first, 'set_goals', {
    goals: [
      { id: 'g1', title: 'state layer' },
      { id: 'g2', title: 'mcp tools' },
      { id: 'g3', title: 'docs' }
    ]
  });
  assert.match(goals, /\[active\] g1 - state layer/);
  assert.match(await call(first, 'next_goal'), /current goal: g1: state layer/);

  assert.match(
    await call(first, 'complete_goal', { goal_id: 'g1', validation: 'node --test: 11 pass' }),
    /completed: g1[\s\S]*next goal: g2: mcp tools/
  );
  await call(first, 'record_decision', { text: 'stdio transport, one sqlite file per workspace' });
  await call(first, 'record_blocker', { text: 'registry needs a workspace cache dir' });

  const cp = await call(first, 'checkpoint', { next_action: 'finish docs, then coverage and complete_project' });
  assert.match(cp, /current_goal: g2: mcp tools/);
  assert.match(cp, /next_action: finish docs, then coverage and complete_project/);
  await first.close();

  // Fresh context: a new process must resume from the same state file alone.
  const second = await connect(dbPath);
  const status = await call(second, 'status');
  assert.match(status, /objective: Ship scope-mcp/);
  assert.match(status, /goals: 1\/3 completed \| pending 1/);
  assert.match(status, /current goal: g2: mcp tools/);
  assert.match(status, /node --test: 11 pass/);
  assert.match(status, /stdio transport, one sqlite file per workspace/);
  assert.match(status, /finish docs, then coverage and complete_project/);
  assert.match(status, /registry needs a workspace cache dir/);

  await call(second, 'complete_goal', { goal_id: 'g2', validation: 'client round-trip passes' });
  await call(second, 'complete_goal', { goal_id: 'g3', validation: 'README covers the workflow' });
  await call(second, 'resolve_blocker', { seq: 1 });

  const notYet = await call(second, 'complete_project');
  assert.match(notYet, /not complete yet/);
  assert.match(notYet, /no scope coverage recorded yet/);

  const covered = await call(second, 'coverage', {
    items: [
      { requirement: 'resume across contexts', status: 'fulfilled', note: 'status + checkpoint' },
      { requirement: 'http transport', status: 'deferred', note: 'stdio is enough' }
    ]
  });
  assert.match(covered, /1 fulfilled, 1 deferred, 0 missing/);

  const done = await call(second, 'complete_project');
  assert.match(done, /project complete/);
  assert.match(done, /deferred: http transport/);
  assert.match(await call(second, 'status'), /status: complete/);
  await second.close();
});

test('blockers can stop a specific goal and unblock on selection', async () => {
  const client = await connect(dbInTmp());
  await call(client, 'init_project', { objective: 'x' });
  await call(client, 'set_goals', { goals: [{ id: 'g1', title: 'only' }] });
  assert.match(await call(client, 'record_blocker', { text: 'registry offline', goal_id: 'g1' }), /goal g1 blocked/);
  assert.match(await call(client, 'status'), /\[blocked\] g1 - only/);
  assert.match(await call(client, 'next_goal', { goal_id: 'g1' }), /current goal: g1: only/);
  assert.match(await call(client, 'status'), /\[active\] g1 - only/);
  await client.close();
});

test('an addendum reopens completion and the index mode keeps context small', async () => {
  const dbPath = dbInTmp();
  const first = await connect(dbPath);
  try {
    await call(first, 'init_project', { objective: 'export reports' });
    await call(first, 'record_scope', { text: 'Export reports as csv.', title: 'base' });
    await call(first, 'set_goals', { goals: [{ id: 'g1', title: 'csv writer' }] });
    await call(first, 'complete_goal', { goal_id: 'g1', validation: 'node --test: 5 pass' });
    await call(first, 'coverage', { items: [{ requirement: 'csv export works', status: 'fulfilled', note: 'tests' }] });
    assert.match(await call(first, 'complete_project'), /project complete/);

    const added = await call(first, 'add_scope_addendum', { text: 'Also accept a --json flag.', title: 'json' });
    assert.match(added, /addendum #2 accepted/);
    assert.match(added, /effective scope now: 1 addendum\(s\) after the base scope/);
    assert.match(added, /re-check goals and coverage/);
    assert.match(await call(first, 'status'), /status: accepted/, 'completion is reopened for re-evaluation');
    assert.match(await call(first, 'complete_project'), /not complete yet|no scope coverage/, 'the new requirement must be evaluated');
  } finally {
    await first.close();
  }

  const second = await connect(dbPath);
  try {
    const index = await call(second, 'get_effective_scope', { include_text: false });
    assert.match(index, /\[#1\] base accepted .* - base \(\d+ chars\)/);
    assert.match(index, /\[#2\] addendum accepted .* - json \(\d+ chars\)/);
    assert.ok(!index.includes('Also accept a --json flag.'), 'index mode omits document bodies');
    assert.match(await call(second, 'get_effective_scope'), /Also accept a --json flag\./, 'full text still available');
    assert.match(await call(second, 'status'), /scope documents: base recorded, addenda: 1 \| effective revision: #2/);
  } finally {
    await second.close();
  }
});

test('tool errors surface as MCP errors', async () => {
  const client = await connect(dbInTmp());
  await call(client, 'init_project', { objective: 'x' });
  await call(client, 'set_goals', { goals: [{ id: 'g1', title: 'only' }] });
  const result = await client.callTool({ name: 'complete_goal', arguments: { goal_id: 'nope', validation: 'proof' } });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /unknown goal id: nope/);
  await client.close();
});

test('scope documents survive across separate MCP sessions', async () => {
  const dbPath = dbInTmp();
  const first = await connect(dbPath);
  try {
    await call(first, 'init_project', { objective: 'x' });
    assert.match(await call(first, 'record_scope', { text: 'Ship the CLI first.', title: 'base' }), /base scope #1 accepted/);
    assert.match(
      await call(first, 'add_scope_addendum', { text: 'Add a --json flag.', title: 'output' }),
      /addendum #2 accepted/
    );
  } finally {
    await first.close();
  }

  const second = await connect(dbPath);
  try {
    const scope = await call(second, 'get_effective_scope');
    assert.match(scope, /\[#1\] base accepted .* - base\nShip the CLI first/);
    assert.match(scope, /\[#2\] addendum accepted .* - output\nAdd a --json flag/);
    assert.match(scope, /1 addendum\(s\) after the base/);
    assert.match(await call(second, 'status'), /effective scope: 1 addendum\(s\) after the base scope/);
  } finally {
    await second.close();
  }
});
