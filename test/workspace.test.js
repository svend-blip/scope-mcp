import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as zlib from 'node:zlib';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { isDelegatedChild } from '../src/hooks.js';
import { hasScope } from '../src/state.js';

// scope-mcp applies only to a repository with its own SCOPE.md, and a server
// shared between workspaces (DSH Web) keeps each workspace's state apart.
// Found 2026-10-20: one shared server served one project's state to every
// session, and the resume brief hijacked delegated review children.

const SERVER = fileURLToPath(new URL('../src/server.js', import.meta.url));

function tmp(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function scopedRepo(objective = 'x') {
  const dir = tmp('scope-mcp-ws-');
  writeFileSync(join(dir, 'SCOPE.md'), `# ${objective}\n`);
  return dir;
}

/** A home directory whose ~/.dsh/sessions holds one session with the given header. */
function homeWithSession(id, header) {
  const home = tmp('scope-mcp-home-');
  const dir = join(home, '.dsh', 'sessions', '--some-workspace--', id);
  mkdirSync(dir, { recursive: true });
  const first = JSON.stringify({ type: 'session', version: 3, id, ...header });
  writeFileSync(join(dir, 'session.v3.jsonl.zstd'), zlib.zstdCompressSync(Buffer.from(`${first}\n{"seq":1}\n`)));
  return home;
}

/** Run one hook the way the DSH bridge does: no --db, payload on stdin, cwd from the payload. */
function runHook(event, payload, env = {}) {
  const cleanEnv = { ...process.env, ...env };
  delete cleanEnv.SCOPE_MCP_DB;
  return execFileSync(process.execPath, ['--no-warnings', SERVER, 'hook', event], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    cwd: tmpdir(),
    env: cleanEnv
  });
}

test('hasScope is true only where a SCOPE.md exists', () => {
  assert.equal(hasScope(scopedRepo()), true);
  assert.equal(hasScope(tmp('scope-mcp-bare-')), false);
});

test('hooks do nothing in a workspace without SCOPE.md and create no state there', () => {
  const bare = tmp('scope-mcp-bare-');
  const out = runHook('prompt-submit', { session_id: 'session-a', cwd: bare });
  assert.equal(out, '');
  assert.equal(existsSync(join(bare, '.scope-mcp')), false);
});

test('hooks inject the resume brief in a scoped workspace, from that workspace state', () => {
  const repo = scopedRepo();
  const out = runHook('session-start', { session_id: 'session-b', cwd: repo });
  assert.match(out, /additionalContext/);
  assert.equal(existsSync(join(repo, '.scope-mcp', 'state.db')), true);
});

const zstd = typeof zlib.zstdCompressSync === 'function' ? {} : { skip: 'node:zlib has no zstd before Node 22.15' };

test('hooks do nothing inside a delegated DSH child session, even in a scoped workspace', zstd, () => {
  const repo = scopedRepo();
  const home = homeWithSession('9753d1ad-child', { origin: 'subagent', delegationDepth: 1, cwd: repo });
  const env = { HOME: home, USERPROFILE: home };
  assert.equal(runHook('prompt-submit', { session_id: '9753d1ad-child', cwd: repo }, env), '');
  assert.equal(runHook('stop', { session_id: '9753d1ad-child', cwd: repo }, env), '');
  assert.equal(existsSync(join(repo, '.scope-mcp')), false);
});

test('hooks find the session under $DSH_HOME, not only ~/.dsh', zstd, () => {
  const repo = scopedRepo();
  const dshHome = join(homeWithSession('c-home', { origin: 'subagent', delegationDepth: 1 }), '.dsh');
  const elsewhere = tmp('scope-mcp-home-');
  const env = { HOME: elsewhere, USERPROFILE: elsewhere, DSH_HOME: dshHome };
  assert.equal(runHook('session-start', { session_id: 'c-home', cwd: repo }, env), '');
});

test('isDelegatedChild reads a DSH 0.2.x session.v4 header too', zstd, () => {
  const home = tmp('scope-mcp-home-');
  const dir = join(home, '.dsh', 'sessions', '--ws--', 'c4');
  mkdirSync(dir, { recursive: true });
  const header = JSON.stringify({ type: 'session', version: 4, id: 'c4', origin: 'subagent', delegationDepth: 1 });
  writeFileSync(join(dir, 'session.v4.jsonl.zstd'), zlib.zstdCompressSync(Buffer.from(`${header}\n`)));
  assert.equal(isDelegatedChild('c4', join(home, '.dsh', 'sessions')), true);
});

test('isDelegatedChild reads the session header; unknown sessions count as top level', zstd, () => {
  const child = homeWithSession('c1', { origin: 'subagent', delegationDepth: 1 });
  const top = homeWithSession('session-t1', { delegationDepth: 0 });
  assert.equal(isDelegatedChild('c1', join(child, '.dsh', 'sessions')), true);
  assert.equal(isDelegatedChild('session-t1', join(top, '.dsh', 'sessions')), false);
  assert.equal(isDelegatedChild('missing', join(top, '.dsh', 'sessions')), false);
  assert.equal(isDelegatedChild('../escape', join(top, '.dsh', 'sessions')), false);
});

async function sharedServer(extraEnv = {}) {
  const env = { ...process.env, SCOPE_MCP_REQUIRE_WORKSPACE: '1', ...extraEnv };
  delete env.SCOPE_MCP_DB;
  const client = new Client({ name: 'scope-mcp-test', version: '0.0.0' });
  await client.connect(
    new StdioClientTransport({ command: process.execPath, args: ['--no-warnings', SERVER], cwd: tmp('scope-mcp-srv-'), env })
  );
  return client;
}

async function call(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  return { text: result.content.map((p) => p.text).join('\n'), isError: Boolean(result.isError) };
}

test('a shared server refuses a call without workspace and a workspace without SCOPE.md', async () => {
  const client = await sharedServer();
  try {
    const noWs = await call(client, 'status');
    assert.equal(noWs.isError, true);
    assert.match(noWs.text, /workspace is required/);
    const bare = tmp('scope-mcp-bare-');
    const unscoped = await call(client, 'status', { workspace: bare });
    assert.equal(unscoped.isError, true);
    assert.match(unscoped.text, /no SCOPE\.md/);
    assert.equal(existsSync(join(bare, '.scope-mcp')), false);
    const relative = await call(client, 'status', { workspace: 'some/repo' });
    assert.equal(relative.isError, true);
  } finally {
    await client.close();
  }
});

test('a shared server keeps two workspaces apart, each in its own state file', async () => {
  const a = scopedRepo('A');
  const b = scopedRepo('B');
  const client = await sharedServer();
  try {
    assert.equal((await call(client, 'init_project', { workspace: a, objective: 'objective of A' })).isError, false);
    assert.equal((await call(client, 'init_project', { workspace: b, objective: 'objective of B' })).isError, false);
    const sa = (await call(client, 'status', { workspace: a })).text;
    const sb = (await call(client, 'status', { workspace: b })).text;
    assert.match(sa, /objective of A/);
    assert.doesNotMatch(sa, /objective of B/);
    assert.match(sb, /objective of B/);
    assert.equal(existsSync(join(a, '.scope-mcp', 'state.db')), true);
    assert.equal(existsSync(join(b, '.scope-mcp', 'state.db')), true);
  } finally {
    await client.close();
  }
});

test('a per-project server without --db serves only a scoped working directory', async () => {
  const env = { ...process.env };
  delete env.SCOPE_MCP_DB;
  delete env.SCOPE_MCP_REQUIRE_WORKSPACE;
  const bare = tmp('scope-mcp-bare-');
  const client = new Client({ name: 'scope-mcp-test', version: '0.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: ['--no-warnings', SERVER], cwd: bare, env }));
  try {
    const r = await call(client, 'status');
    assert.equal(r.isError, true);
    assert.match(r.text, /no SCOPE\.md/);
  } finally {
    await client.close();
  }
});
