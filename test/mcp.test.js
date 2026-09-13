import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// A URL's .pathname is POSIX-shaped even on Windows ("/C:/Users/..."), and
// Windows then resolves it as "C:\C:\Users\...". fileURLToPath yields a
// native absolute path on every platform instead.
const SERVER = fileURLToPath(new URL('../src/server.js', import.meta.url));

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

test('server launch path is a native absolute path, never a URL pathname', () => {
  assert.ok(isAbsolute(SERVER), `server path must be absolute: ${SERVER}`);
  assert.equal(
    resolve(SERVER),
    SERVER,
    'server path must already be fully resolved, not a POSIX pathname pending drive/root normalization'
  );
  assert.ok(existsSync(SERVER), `server file must exist at the computed path: ${SERVER}`);

  if (process.platform === 'win32') {
    assert.match(SERVER, /^[A-Za-z]:[\\/]/, 'a Windows path must start with a drive root');
    assert.doesNotMatch(
      SERVER,
      /^[A-Za-z]:[\\/][A-Za-z]:[\\/]/,
      `a Windows path must never duplicate its drive root, e.g. C:\\C:\\...: ${SERVER}`
    );
  } else {
    assert.match(SERVER, /^\//, 'a POSIX path must start at the filesystem root');
    assert.ok(!SERVER.includes('\\'), 'a POSIX path must not contain backslashes');
  }

  // Regression for the duplicated-drive bug: simulate how Windows resolves
  // argv[1] regardless of the host platform. A URL pathname such as
  // "/C:/Users/..." resolves to "C:\C:\Users\..." and must be rejected here.
  const asWindowsSeesIt = win32.resolve(SERVER);
  assert.doesNotMatch(
    asWindowsSeesIt,
    /^[A-Za-z]:[\\/][A-Za-z]:[\\/]/,
    `Windows resolution must not produce a doubled root like C:\\C:\\...: ${asWindowsSeesIt}`
  );
});

test('per-call workspace argument binds state to <workspace>/.scope-mcp/state.db', async () => {
  const client = await connect(dbInTmp());
  const ws = mkdtempSync(join(tmpdir(), 'scope-mcp-ws-'));
  await call(client, 'init_project', { objective: 'Workspace project', workspace: ws });
  await call(client, 'set_goals', { workspace: ws, goals: [{ id: 'g1', title: 'one' }] });
  const status = await call(client, 'status', { workspace: ws });
  assert.match(status, /objective: Workspace project/);
  assert.match(status, /\[active\] g1 - one/);
  assert.ok(existsSync(join(ws, '.scope-mcp', 'state.db')), 'state file lives inside the workspace');
  const def = await call(client, 'status');
  assert.doesNotMatch(def, /Workspace project/, 'the server default store is not touched by workspace calls');
  await client.close();
});

test('server exposes a small tool surface over stdio', async () => {
  const client = await connect(dbInTmp());
  const { tools } = await client.listTools();
  assert.deepEqual(
    tools.map((t) => t.name).sort(),
    [
      'checkpoint',
      'complete_goal',
      'complete_project',
      'coverage',
      'doctor',
      'init_project',
      'next_goal',
      'record_blocker',
      'record_decision',
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

test('tool errors surface as MCP errors', async () => {
  const client = await connect(dbInTmp());
  await call(client, 'init_project', { objective: 'x' });
  await call(client, 'set_goals', { goals: [{ id: 'g1', title: 'only' }] });
  const result = await client.callTool({ name: 'complete_goal', arguments: { goal_id: 'nope', validation: 'proof' } });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /unknown goal id: nope/);
  await client.close();
});

test('workspace paths containing spaces bind state correctly', async () => {
  const client = await connect(dbInTmp());
  const ws = join(mkdtempSync(join(tmpdir(), 'scope-mcp ws-')), 'dir with spaces');
  await call(client, 'init_project', { objective: 'Spaced workspace', workspace: ws });
  const status = await call(client, 'status', { workspace: ws });
  assert.match(status, /objective: Spaced workspace/);
  assert.ok(existsSync(join(ws, '.scope-mcp', 'state.db')), 'state file lands inside the spaced workspace path');
  await client.close();
});

test('doctor reports a read-only environment diagnostic', async () => {
  const client = await connect(dbInTmp());
  const ws = mkdtempSync(join(tmpdir(), 'scope-mcp-doctor-'));
  const report = await call(client, 'doctor', { workspace: ws });
  assert.match(report, /platform: /);
  assert.match(report, /node executable: /);
  assert.match(report, /node version: /);
  assert.match(report, /node:sqlite: available/);
  assert.match(report, /effective project state path: /);
  assert.match(report, /state directory/);
  assert.match(report, /workspace state path: /);
  await client.close();
});
