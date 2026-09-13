import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ProjectState } from '../src/state.js';

const SERVER = new URL('../src/server.js', import.meta.url).pathname;

function workspaceDir(label) {
  const dir = mkdtempSync(join(tmpdir(), `scope-lifecycle-${label}-`));
  return dir;
}

/** Run the CLI against one workspace's state file, from a clean process. */
function cli(dbPath, ...args) {
  return execFileSync(process.execPath, [SERVER, '--db', dbPath, ...args], { encoding: 'utf8' });
}

function stateFile(dir) {
  return join(dir, '.scope-mcp', 'state.db');
}

test('base scope and ordered addenda survive separate processes', () => {
  const dir = workspaceDir('persist');
  const db = stateFile(dir);
  try {
    cli(db, '--status'); // first process creates the file

    const first = new ProjectState(db);
    first.init({ objective: 'ship the reporting module' });
    first.recordScope({ text: 'Ship a reporting module with csv export.', title: 'base' });
    first.addScopeAddendum({ text: 'Add a --json flag to the export command.', title: 'json flag' });
    first.addScopeAddendum({ text: 'Export must stream for files over 100 MB.', title: 'streaming' });
    first.close();

    // A brand new process, with nothing but the file.
    const second = new ProjectState(db);
    const docs = second.scopeDocs();
    assert.deepEqual(docs.map((d) => `${d.kind}:${d.title}`), ['base:base', 'addendum:json flag', 'addendum:streaming']);
    assert.ok(docs[0].seq < docs[1].seq && docs[1].seq < docs[2].seq, 'order is the accepted order');

    const scope = second.effectiveScope();
    assert.match(scope.text, /\[#\d+\] base accepted .*\nShip a reporting module/);
    assert.match(scope.text, /addendum accepted .*\nAdd a --json flag/);
    assert.match(scope.text, /stream for files over 100 MB/);
    assert.equal(scope.addenda.length, 2);
    second.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('status reports scope metadata without dumping the documents', () => {
  const store = new ProjectState(':memory:');
  store.init({ objective: 'keep intent separate from progress' });
  store.recordScope({ text: 'A long base scope '.repeat(6), title: 'base' });
  store.addScopeAddendum({ text: 'second requirement', title: 'two' });
  store.addScopeAddendum({ text: 'third requirement', title: 'three' });

  const status = store.statusText();
  assert.match(status, /scope documents: base recorded, addenda: 2 \| effective revision: #3/);
  assert.match(status, /effective scope: 2 addendum\(s\) after the base scope/);
  assert.ok(!status.includes('A long base scope A long base scope'), 'status summarizes instead of echoing documents');

  const index = store.scopeDocs().map((doc) => `${doc.seq}:${doc.kind}`);
  assert.deepEqual(index, ['1:base', '2:addendum', '3:addendum'], 'provenance stays inspectable');
  store.close();
});

test('checkpoints record the working position, not the scope text', () => {
  const store = new ProjectState(':memory:');
  store.init({ objective: 'csv export' });
  const scopeText = 'Export every report as csv with headers, quoting and a deterministic column order.';
  store.recordScope({ text: scopeText, title: 'base' });
  store.setGoals([{ id: 'g1', title: 'csv writer' }]);
  store.completeGoal('g1', 'node --test: 4 pass');

  const cp = store.checkpoint({ next_action: 'add the --json flag' });
  assert.equal(cp.payload.next_action, 'add the --json flag');
  assert.ok(!cp.payload.work_completed.includes(scopeText), 'checkpoint summarizes instead of copying scope text');
  assert.ok(!cp.payload.current_goal.includes(scopeText));
  store.close();
});

test('the resume brief stays short and points at the effective scope', () => {
  const store = new ProjectState(':memory:');
  store.init({ objective: 'keep the brief small' });
  store.recordScope({ text: 'Base scope body.', title: 'base' });
  store.addScopeAddendum({ text: 'One more accepted requirement.', title: 'extra' });
  store.setGoals([{ id: 'g1', title: 'first step' }, { id: 'g2', title: 'second step' }]);
  store.completeGoal('g1', 'npm test: 9 pass');

  const brief = store.resumeBrief();
  assert.ok(brief.length < 900, `brief stays injectable (${brief.length} chars)`);
  assert.match(brief, /effective scope: 1 addendum\(s\) after the base scope/);
  assert.match(brief, /retrieve it with get_effective_scope before project-level decisions/);
  assert.match(brief, /next action: continue g2: second step/, 'unfinished work is the resume point');
  assert.ok(!brief.includes('One more accepted requirement'), 'the brief summarizes the intent instead of embedding it');
  store.close();
});

test('an accepted addendum keeps goals and coverage and reopens completion', () => {
  const store = new ProjectState(':memory:');
  store.init({ objective: 'reporting module' });
  store.recordScope({ text: 'csv export', title: 'base' });
  store.setGoals([
    { id: 'g1', title: 'csv writer' },
    { id: 'g2', title: 'headers configurable' }
  ]);
  store.completeGoal('g1', 'node --test: 6 pass');
  store.completeGoal('g2', 'node --test: 8 pass');
  store.setCoverage([{ requirement: 'csv export works', status: 'fulfilled', note: 'tests' }]);
  assert.equal(store.completeProject().complete, true);
  assert.equal(store.isComplete(), true);

  store.addScopeAddendum({ text: 'Add a --json flag to the export command.', title: 'json flag' });

  assert.equal(store.isComplete(), false, 'new intent reopens the completion check');
  assert.equal(store.meta('completed_at'), null, 'the stale completion stamp is cleared');
  const goals = store.goalRows();
  assert.equal(goals.length, 2, 'completed goals survive');
  assert.ok(goals.every((g) => g.status === 'completed'));
  assert.equal(store.coverageRows().length, 1, 'valid coverage stays');

  // The model reconciles: new work becomes a goal, then coverage covers it.
  store.setGoals([
    ...goals.map((g) => ({ id: g.id, title: g.title, status: 'completed' })),
    { id: 'g3', title: 'json flag' }
  ]);
  assert.equal(store.activeGoalRow().id, 'g3');
  assert.equal(store.completeProject().complete, false, 'the new requirement is not fulfilled yet');

  store.completeGoal('g3', 'node --test: 10 pass');
  store.setCoverage([{ requirement: '--json flag emits json', status: 'fulfilled', note: 'cli test' }]);
  assert.equal(store.completeProject().complete, true);
  store.close();
});

test('an older database migrates by gaining the scope table without losing state', () => {
  const dir = workspaceDir('migrate');
  const db = join(dir, 'state.db');
  try {
    const old = new DatabaseSync(db);
    old.exec(
      'CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);' +
        'CREATE TABLE goals (id TEXT PRIMARY KEY, seq INTEGER NOT NULL, title TEXT NOT NULL,' +
        " description TEXT NOT NULL DEFAULT '', status TEXT NOT NULL," +
        " validation TEXT NOT NULL DEFAULT '', completed_at TEXT NOT NULL DEFAULT '');" +
        'CREATE TABLE decisions (seq INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, text TEXT NOT NULL);' +
        'CREATE TABLE blockers (seq INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, text TEXT NOT NULL,' +
        " resolved_at TEXT NOT NULL DEFAULT '');" +
        'CREATE TABLE coverage (requirement TEXT PRIMARY KEY, status TEXT NOT NULL,' +
        " note TEXT NOT NULL DEFAULT '', at TEXT NOT NULL);" +
        'CREATE TABLE checkpoints (seq INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, payload TEXT NOT NULL);'
    );
    old.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('objective', 'legacy project');
    old.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('scope_file', 'SCOPE.md');
    old
      .prepare('INSERT INTO goals (id, seq, title, status, validation, completed_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run('g1', 0, 'legacy step', 'completed', 'legacy check passed', '2026-01-01T00:00:00.000Z');
    old.close();

    const store = new ProjectState(db);
    assert.equal(store.meta('objective'), 'legacy project', 'execution state survives');
    assert.equal(store.goalRows()[0].validation, 'legacy check passed');
    assert.match(store.scopeSummary(), /not recorded here/, 'a missing base scope is reported, not invented');
    assert.deepEqual(store.scopeMetadata(), { recorded: false, addenda: 0, latest: null });

    store.recordScope({ text: 'Legacy project keeps working with a recorded scope.', title: 'imported' });
    assert.equal(store.scopeDocs().length, 1);
    assert.deepEqual(store.scopeMetadata(), { recorded: true, addenda: 0, latest: 1 });
    assert.equal(store.goalRows().length, 1, 'recording scope leaves goals alone');
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('workspaces keep independent intent and handle spaces in their paths', () => {
  const root = workspaceDir('isolation');
  const alpha = join(root, 'Project Alpha');
  const beta = join(root, 'Project Beta');
  mkdirSync(alpha, { recursive: true });
  mkdirSync(beta, { recursive: true });
  try {
    for (const [dir, text] of [[alpha, 'alpha scope'], [beta, 'beta scope']]) {
      const store = new ProjectState(join(dir, '.scope-mcp', 'state.db'));
      store.init({ objective: `${text} objective` });
      store.recordScope({ text, title: 'base' });
      store.addScopeAddendum({ text: `${text} extra`, title: 'extra' });
      store.setGoals([{ id: 'g1', title: `${text} step` }]);
      store.close();
    }

    for (const [dir, text] of [[alpha, 'alpha scope'], [beta, 'beta scope']]) {
      const store = new ProjectState(join(dir, '.scope-mcp', 'state.db'));
      assert.equal(store.baseScope().text, text);
      assert.equal(store.scopeDocs().length, 2);
      assert.equal(store.goalRows()[0].title, `${text} step`);
      store.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
