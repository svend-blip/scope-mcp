import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectState } from '../src/state.js';
import { fileURLToPath } from 'node:url';

// A native path: URL.pathname is POSIX-shaped on Windows (/D:/a/...), and node
// then looks for D:\\D:\\a\\... - found when the suite first ran there (CI, 2026-09-21).
const SERVER = fileURLToPath(new URL('../src/server.js', import.meta.url));

function freshPath() {
  return join(mkdtempSync(join(tmpdir(), 'scope-mcp-scope-')), 'state.db');
}

/** Shell view a cold-started context gets, from a separate process. */
function statusFromCli(dbPath) {
  return execFileSync(process.execPath, ['--no-warnings', SERVER, '--db', dbPath, '--status'], { encoding: 'utf8' });
}

const BASE = 'Build scope-mcp: durable scope-driven project state so one agent finishes a scope across many context windows.';
const ADDENDUM =
  'Addendum: persist the accepted scope and its addenda inside scope-mcp, so a fresh context never needs them pasted again.';

test('cold start: base scope, progress, addendum, discard, fresh session reconciles', () => {
  const dbPath = freshPath();

  // --- working session -------------------------------------------------
  const first = new ProjectState(dbPath);
  first.init({ objective: 'Build scope-mcp.' });
  first.recordScope({ text: BASE, title: 'base scope' });
  first.setGoals([
    { id: 'g1', title: 'sqlite state layer' },
    { id: 'g2', title: 'mcp tools' }
  ]);
  first.completeGoal('g1', 'node --test: state tests pass');
  first.addScopeAddendum({ text: ADDENDUM, title: 'scope persistence' });
  first.close(); // original process is gone

  // --- fresh session, nothing remembered -------------------------------
  const status = statusFromCli(dbPath);
  assert.match(status, /effective scope: 1 addendum\(s\) after the base scope.*scope persistence/);
  assert.match(status, /accepted scope documents, in order:/);
  const resumed = new ProjectState(dbPath);
  const scope = resumed.effectiveScope();
  assert.equal(scope.base.text, BASE);
  assert.equal(scope.addenda.length, 1);
  assert.match(scope.text, /never needs them pasted again/, 'effective text includes the addendum');
  assert.ok(scope.text.indexOf('Build scope-mcp') < scope.text.indexOf('never needs them pasted again'), 'base first, then addendum');

  // Reconcile: completed work is kept, one goal added because the addendum asks for it.
  resumed.setGoals([
    { id: 'g1', title: 'sqlite state layer', status: 'completed' },
    { id: 'g2', title: 'mcp tools' },
    { id: 'g3', title: 'persist scope documents' }
  ]);
  assert.equal(resumed.goalRows().find((g) => g.id === 'g1').status, 'completed');
  assert.equal(resumed.nextGoal().id, 'g2', 'work resumes at the unfinished goal');

  resumed.completeGoal('g2', 'mcp round-trip passes');
  resumed.completeGoal('g3', 'record_scope/add_scope_addendum/get_effective_scope round-trip');
  resumed.checkpoint({ next_action: 'record coverage and call complete_project' });
  assert.equal(resumed.lastCheckpoint().payload.next_action, 'record coverage and call complete_project');
  resumed.close();

  // --- second cold start reads the reconciled position -------------------
  const again = new ProjectState(dbPath);
  assert.equal(again.nextGoal(), null);
  assert.match(statusFromCli(dbPath), /\[completed\] g3 - persist scope documents/);
  assert.equal(again.goalRows().length, 3, 'no goal duplication across reconciliations');
  assert.equal(again.scopeDocs().length, 2);
  again.close();
});

test('status and resume brief tell a fresh context to read the effective scope', () => {
  const store = new ProjectState(freshPath());
  store.init({ objective: 'Build scope-mcp.' });
  store.recordScope({ text: BASE, title: 'base scope' });
  store.setGoals([{ id: 'g1', title: 'state layer' }]);

  assert.match(store.statusText(), /effective scope: 0 addendum\(s\) after the base scope.*base scope/);
  assert.match(store.resumeBrief(), /effective scope: .*read the effective scope before continuing/);
  store.close();
});

test('a later base scope supersedes the previous one but keeps its history', () => {
  const store = new ProjectState(freshPath());
  store.init({ objective: 'x' });
  store.recordScope({ text: 'old base', title: 'first' });
  store.addScopeAddendum({ text: 'old addendum' });
  store.recordScope({ text: 'new base', title: 'second' });

  const scope = store.effectiveScope();
  assert.equal(scope.base.title, 'second');
  assert.equal(scope.addenda.length, 0);
  assert.equal(store.scopeDocs().length, 1, 'only the active chain is effective');
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM scope_docs').get().n, 3, 'superseded rows are kept');
  store.close();
});

test('an addendum needs a base scope, and init reset keeps durable intent', () => {
  const store = new ProjectState(freshPath());
  assert.throws(() => store.addScopeAddendum({ text: 'orphan' }), /needs a base scope first/);

  store.init({ objective: 'one' });
  store.recordScope({ text: BASE, title: 'base scope' });
  store.addScopeAddendum({ text: ADDENDUM, title: 'scope persistence' });
  store.setGoals([{ id: 'g1', title: 'thing' }]);

  store.init({ objective: 'two', reset: true });
  assert.equal(store.goalRows().length, 0, 'reset clears tracked work');
  assert.equal(store.scopeDocs().length, 2, 'accepted scope documents survive a reset');
  assert.match(store.scopeSummary(), /read the effective scope before continuing/);
  store.close();
});

test('without recorded scope documents the file on disk stays the contract', () => {
  const store = new ProjectState(freshPath());
  store.init({ objective: 'x' });
  assert.equal(store.effectiveScope(), null);
  assert.equal(store.scopeSummary(), 'not recorded here - read SCOPE.md');
  assert.match(store.resumeBrief(), /next action: \(unset - read the effective scope, then call status\)/);
  store.close();
});
