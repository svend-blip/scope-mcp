import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { ProjectState, defaultDbPath } from '../src/state.js';

function freshPath() {
  const dir = mkdtempSync(join(tmpdir(), 'scope-mcp-'));
  return join(dir, 'state.db');
}

test('defaultDbPath builds a native absolute path without duplicated roots', () => {
  const cwd = process.cwd();
  assert.equal(defaultDbPath(cwd), join(cwd, '.scope-mcp', 'state.db'), 'db path must come from node:path');
  assert.ok(isAbsolute(defaultDbPath()), 'workspace db path must be absolute');
  if (process.platform === 'win32') {
    assert.match(defaultDbPath(), /^[A-Za-z]:[\\/]/, 'a Windows db path must start with a drive root');
    assert.doesNotMatch(
      defaultDbPath(),
      /^[A-Za-z]:[\\/][A-Za-z]:[\\/]/,
      'a Windows db path must never duplicate its drive root'
    );
  }
});

test('project initialization records objective and scope, and is idempotent', () => {
  const path = freshPath();
  const store = new ProjectState(path);
  const out = store.init({ objective: 'Build scope-mcp', scopeFile: 'SCOPE.md' });
  assert.match(out, /objective: Build scope-mcp/);
  assert.match(out, /status: accepted/);

  store.setGoals([{ id: 'g1', title: 'one' }]);
  store.init({ objective: 'Build scope-mcp' });
  assert.equal(store.goalRows().length, 1, 'init must not wipe tracked state');
  assert.equal(store.meta('objective'), 'Build scope-mcp');

  store.init({ objective: 'again', reset: true });
  assert.equal(store.goalRows().length, 0);
  store.close();
});

test('goal creation and update preserve recorded progress', () => {
  const store = new ProjectState(freshPath());
  store.init({ objective: 'x' });
  store.setGoals([
    { id: 'g1', title: 'first' },
    { id: 'g2', title: 'second' }
  ]);
  assert.equal(store.activeGoalRow().id, 'g1', 'first pending goal becomes active');

  store.completeGoal('g1', 'node --test passes');
  store.setGoals([
    { id: 'g1', title: 'first (renamed)' },
    { id: 'g3', title: 'third' }
  ]);
  const rows = store.goalRows();
  assert.equal(rows.find((r) => r.id === 'g1').status, 'completed', 'completed status survives re-list');
  assert.equal(rows.find((r) => r.id === 'g1').title, 'first (renamed)', 'titles update in place');
  assert.ok(rows.some((r) => r.id === 'g3'));
  assert.ok(!rows.some((r) => r.id === 'g2'), 'unlisted unfinished goal is dropped');
  assert.equal(store.activeGoalRow().id, 'g3');
  store.close();
});

test('goal progression completes goals with validation and advances the queue', () => {
  const store = new ProjectState(freshPath());
  store.init({ objective: 'x' });
  store.setGoals([
    { id: 'g1', title: 'first' },
    { id: 'g2', title: 'second' }
  ]);

  assert.equal(store.nextGoal().id, 'g1');
  const done = store.completeGoal('g1', 'tests green');
  assert.equal(done.status, 'completed');
  assert.match(done.validation, /tests green/);
  assert.ok(done.completed_at);
  assert.equal(store.nextGoal().id, 'g2', 'next pending goal is promoted');

  store.completeGoal('g2', 'demo run');
  assert.equal(store.nextGoal(), null);
  assert.equal(store.coverageSummary().fulfilled, 0);
  store.close();
});

test('complete_goal requires validation and unknown ids are rejected', () => {
  const store = new ProjectState(freshPath());
  store.init({ objective: 'x' });
  store.setGoals([{ id: 'g1', title: 'first' }]);
  assert.throws(() => store.completeGoal('g1', ''), /validation/);
  assert.throws(() => store.completeGoal('nope', 'ok'), /unknown goal id/);
  assert.throws(() => store.nextGoal('nope'), /unknown goal id/);
  assert.equal(store.activeGoalRow().id, 'g1', 'failed calls leave state intact');
  store.close();
});

test('next_goal can select a goal explicitly', () => {
  const store = new ProjectState(freshPath());
  store.init({ objective: 'x' });
  store.setGoals([
    { id: 'g1', title: 'first' },
    { id: 'g2', title: 'second' }
  ]);
  assert.equal(store.nextGoal('g2').id, 'g2');
  assert.equal(store.activeGoalRow().id, 'g2');
  assert.equal(store.nextGoal().id, 'g2', 'repeat call is stable');
  store.close();
});

test('checkpoints, decisions and blockers survive a restart', () => {
  const path = freshPath();
  const first = new ProjectState(path);
  first.init({ objective: 'long horizon project' });
  first.setGoals([
    { id: 'g1', title: 'scaffold' },
    { id: 'g2', title: 'tests' }
  ]);
  first.completeGoal('g1', 'node --test: 8 pass');
  first.addDecision('state lives in .scope-mcp/state.db');
  first.addBlocker('npm cache is read-only; use a workspace cache dir');
  first.checkpoint({ next_action: 'write the MCP tool layer' });
  first.close();

  const second = new ProjectState(path);
  const status = second.statusText();
  assert.match(status, /objective: long horizon project/);
  assert.match(status, /\[completed\] g1 - scaffold \(node --test: 8 pass\)/);
  assert.match(status, /\[active\] g2 - tests/);
  assert.match(status, /state lives in \.scope-mcp\/state\.db/);
  assert.match(status, /read-only/);
  assert.match(status, /write the MCP tool layer/);
  assert.equal(second.meta('next_action'), 'write the MCP tool layer');
  assert.equal(second.lastCheckpoint().payload.work_completed, 'g1: node --test: 8 pass');
  assert.equal(second.validationState(), 'g1=node --test: 8 pass');

  assert.equal(second.resolveBlocker(1).resolved_at !== '', true);
  assert.equal(second.openBlockers().length, 0);
  second.close();
});

test('checkpoint derives its snapshot from stored state', () => {
  const store = new ProjectState(freshPath());
  store.init({ objective: 'x' });
  store.setGoals([{ id: 'g1', title: 'first' }]);
  store.completeGoal('g1', 'checked by hand');
  store.addDecision('prefer stdio transport');
  store.checkpoint({ next_action: 'add coverage tool' });
  const cp = store.lastCheckpoint();
  assert.equal(cp.payload.current_goal, '');
  assert.equal(cp.payload.work_completed, 'g1: checked by hand');
  assert.equal(cp.payload.validation_state, 'g1=checked by hand');
  assert.equal(cp.payload.important_decisions, 'prefer stdio transport');
  assert.equal(cp.payload.next_action, 'add coverage tool');
  assert.equal(cp.at, store.lastCheckpointAt());
  store.close();
});

test('blockers can attach to a goal and mark it blocked', () => {
  const store = new ProjectState(freshPath());
  store.init({ objective: 'x' });
  store.setGoals([
    { id: 'g1', title: 'first' },
    { id: 'g2', title: 'second' }
  ]);
  store.blockGoal('g1', 'waiting on registry access');
  assert.equal(store.goalRows().find((r) => r.id === 'g1').status, 'blocked');
  assert.equal(store.activeGoalRow().id, 'g2', 'a blocked goal is not current');
  assert.equal(store.openBlockers()[0].text, 'g1: waiting on registry access');
  store.resolveBlocker(1);
  assert.equal(store.nextGoal('g1').status, 'active', 're-selecting unblocks the goal');
  store.close();
});

test('coverage is recorded per requirement and summarised', () => {
  const store = new ProjectState(freshPath());
  store.init({ objective: 'x' });
  store.setCoverage([
    { requirement: 'stdio transport', status: 'fulfilled', note: 'src/server.js' },
    { requirement: 'http transport', status: 'deferred', note: 'out of scope' },
    { requirement: 'docker packaging', status: 'missing' }
  ]);
  assert.deepEqual(store.coverageSummary(), { fulfilled: 1, deferred: 1, missing: 1 });
  store.setCoverage([{ requirement: 'docker packaging', status: 'deferred', note: 'not needed locally' }]);
  assert.deepEqual(store.coverageSummary(), { fulfilled: 1, deferred: 2, missing: 0 });
  assert.equal(store.coverageRows().length, 3, 'requirement text is the key');
  store.close();
});

test('completion needs coverage and finished goals', () => {
  const store = new ProjectState(freshPath());
  store.init({ objective: 'x' });
  store.setGoals([{ id: 'g1', title: 'first' }]);

  let report = store.completeProject();
  assert.equal(report.complete, false);
  assert.ok(report.missing.some((m) => m.includes('coverage')));
  assert.equal(store.isComplete(), false);

  store.completeGoal('g1', 'all checks pass');
  store.setCoverage([{ requirement: 'tests pass', status: 'missing' }]);
  report = store.completeProject();
  assert.equal(report.complete, false);
  assert.ok(report.missing.some((m) => m.startsWith('gap -')));

  store.setCoverage([{ requirement: 'tests pass', status: 'fulfilled', note: 'node --test' }]);
  report = store.completeProject();
  assert.equal(report.complete, true);
  assert.equal(store.isComplete(), true);
  assert.equal(store.meta('completed_at') !== '', true);
  assert.equal(store.statusText().includes('status: complete'), true);
  store.close();
});

test('completion can be forced past remaining gaps', () => {
  const store = new ProjectState(freshPath());
  store.init({ objective: 'x' });
  store.setGoals([{ id: 'g1', title: 'first' }]);
  const report = store.completeProject({ force: true });
  assert.equal(report.complete, true);
  assert.equal(report.missing.length, 0);
  assert.equal(store.isComplete(), true);
  store.close();
});

test('blocking a completed goal keeps its result and still records the issue', () => {
  const store = new ProjectState(freshPath());
  store.init({ objective: 'x' });
  store.setGoals([{ id: 'g1', title: 'first' }]);
  store.completeGoal('g1', 'verified once');
  store.blockGoal('g1', 'later follow-up noticed');
  assert.equal(store.goalRows().find((r) => r.id === 'g1').status, 'completed');
  assert.equal(store.openBlockers()[0].text, 'g1: later follow-up noticed');
  store.setCoverage([{ requirement: 'first goal delivered', status: 'fulfilled' }]);
  const report = store.completeProject();
  assert.equal(report.complete, true);
  assert.deepEqual(report.blockers, ['g1: later follow-up noticed'], 'open blockers are reported, not silently dropped');
  store.close();
});
