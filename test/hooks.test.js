import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { ProjectState } from '../src/state.js';

const HOOKS = fileURLToPath(new URL('../scripts/scope-hooks.js', import.meta.url));

function runHook(verb, cwd, payload) {
  return spawnSync(process.execPath, ['--no-warnings', HOOKS, verb], {
    cwd,
    input: payload === undefined ? '' : JSON.stringify(payload),
    encoding: 'utf8'
  });
}

function checkpointCount(dbPath) {
  const db = new DatabaseSync(dbPath);
  try {
    return db.prepare('SELECT COUNT(*) AS n FROM checkpoints').get().n;
  } finally {
    db.close();
  }
}

function seedWorkspace() {
  const ws = mkdtempSync(join(tmpdir(), 'scope-mcp-hooks-'));
  const dbPath = join(ws, '.scope-mcp', 'state.db');
  const store = new ProjectState(dbPath);
  store.init({ objective: 'Resume-proof project' });
  store.setGoals([
    { id: 'g1', title: 'state layer' },
    { id: 'g2', title: 'hook wiring' }
  ]);
  store.completeGoal('g1', 'npm test passes');
  store.checkpoint({ next_action: 'wire the checkpoint hook for g2' });
  store.close();
  return { ws, dbPath };
}

test('resume hook emits Claude Code SessionStart additionalContext from workspace state', () => {
  const { ws } = seedWorkspace();
  const run = runHook('resume', ws, { session_id: 's1', cwd: ws, hook_event_name: 'SessionStart', source: 'startup' });
  assert.equal(run.status, 0, `resume hook must exit 0, stderr: ${run.stderr}`);
  const out = JSON.parse(run.stdout.trim());
  assert.equal(out.hookSpecificOutput.hookEventName, 'SessionStart');
  const ctx = out.hookSpecificOutput.additionalContext;
  assert.match(ctx, /objective: Resume-proof project/);
  assert.match(ctx, /current goal: g2: hook wiring/);
  assert.match(ctx, /next action: wire the checkpoint hook for g2/);
  assert.match(ctx, /resume-work skill/);
});

test('resume hook emits empty JSON for an untracked workspace', () => {
  const ws = mkdtempSync(join(tmpdir(), 'scope-mcp-hooks-empty-'));
  const run = runHook('resume', ws, { session_id: 's2', cwd: ws, hook_event_name: 'SessionStart', source: 'startup' });
  assert.equal(run.status, 0, `resume hook must exit 0, stderr: ${run.stderr}`);
  const out = JSON.parse(run.stdout.trim());
  assert.equal(out.hookSpecificOutput, undefined, 'no additionalContext for a workspace without scope-mcp state');
});

test('checkpoint hook snapshots only when the working position changed', () => {
  const { ws, dbPath } = seedWorkspace();
  // The seed already checkpointed this exact position: the hook must detect
  // the unchanged position and append nothing.
  const first = runHook('checkpoint', ws, { session_id: 's3', cwd: ws, hook_event_name: 'Stop' });
  assert.equal(first.status, 0, `checkpoint hook must exit 0, stderr: ${first.stderr}`);
  assert.equal(checkpointCount(dbPath), 1, 'an unchanged position must not append checkpoint rows');

  const repeat = runHook('checkpoint', ws, { session_id: 's4', cwd: ws, hook_event_name: 'Stop' });
  assert.equal(repeat.status, 0);
  assert.equal(checkpointCount(dbPath), 1, 'repeated Stop hooks without progress stay idempotent');

  // Real progress changes the position: the next Stop hook snapshots again.
  const store = new ProjectState(dbPath);
  store.completeGoal('g2', 'hook round-trip verified');
  store.close();
  const third = runHook('checkpoint', ws, { session_id: 's5', cwd: ws, hook_event_name: 'Stop' });
  assert.equal(third.status, 0);
  assert.equal(checkpointCount(dbPath), 2, 'a changed position appends exactly one checkpoint row');
});
