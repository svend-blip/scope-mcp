import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectState } from '../src/state.js';
import { handleHook, hookOutput, normalizeEvent } from '../src/hooks.js';

const SERVER = new URL('../src/server.js', import.meta.url).pathname;

function freshPath() {
  return join(mkdtempSync(join(tmpdir(), 'scope-mcp-hooks-')), 'state.db');
}

/** Run one Harness hook exactly as the bridge does: payload on stdin, stdout decoded. */
function runHook(dbPath, event, payload) {
  return execFileSync(process.execPath, ['--no-warnings', SERVER, '--db', dbPath, 'hook', event], {
    input: JSON.stringify(payload),
    encoding: 'utf8'
  });
}

/** A project with partial progress, as one working context would leave it. */
function seedWork(dbPath) {
  const store = new ProjectState(dbPath);
  store.init({ objective: 'Add automatic checkpoint and resume behaviour to scope-mcp.' });
  store.setGoals([
    { id: 'g1', title: 'state layer' },
    { id: 'g2', title: 'hooks' },
    { id: 'g3', title: 'docs' }
  ]);
  store.completeGoal('g1', 'node --test: state tests pass');
  store.addDecision('reuse harness hooks bridge instead of a daemon');
  store.addBlocker('profile patch must be reloaded for hook config to apply');
  store.close(); // the original working context is now gone
}

test('Stop hook persists a checkpoint before the working context is lost', () => {
  const dbPath = freshPath();
  seedWork(dbPath);

  const out = runHook(dbPath, 'stop', { hook_event_name: 'Stop', session_id: 'session-a', cwd: '/work/project' });
  assert.match(out, /^checkpoint /);
  assert.match(out, /g2: hooks/);

  const resumed = new ProjectState(dbPath);
  const cp = resumed.lastCheckpoint();
  assert.equal(cp.payload.current_goal, 'g2: hooks');
  assert.equal(cp.payload.work_completed, 'g1: node --test: state tests pass');
  assert.equal(cp.payload.validation_state, 'g1=node --test: state tests pass');
  assert.equal(cp.payload.unresolved_issues, 'profile patch must be reloaded for hook config to apply');
  assert.equal(cp.payload.next_action, 'continue g2: hooks', 'next action is derived without being told');
  assert.equal(cp.payload.important_decisions, 'reuse harness hooks bridge instead of a daemon');
  resumed.close();
});

test('SessionStart hook resumes a fresh context from durable state alone', () => {
  const dbPath = freshPath();
  seedWork(dbPath);
  runHook(dbPath, 'stop', { hook_event_name: 'Stop', session_id: 'session-a' });

  // Fresh context: a new process that never saw the original conversation.
  const out = runHook(dbPath, 'session-start', { hook_event_name: 'SessionStart', source: 'startup', session_id: 'session-b' });
  const decoded = JSON.parse(out);
  assert.equal(decoded.hookSpecificOutput.hookEventName, 'SessionStart');

  const brief = decoded.hookSpecificOutput.additionalContext;
  assert.match(brief, /current goal: g2: hooks/);
  assert.match(brief, /next action: continue g2: hooks/);
  assert.match(brief, /completed: g1 \(node --test: state tests pass\)/);
  assert.match(brief, /profile patch must be reloaded/);
  assert.match(brief, /continue autonomously from the next action/);
  assert.ok(brief.split('\n').length <= 8, 'the injected brief stays small');
});

test('a resumed context keeps working and records further progress', () => {
  const dbPath = freshPath();
  seedWork(dbPath);
  runHook(dbPath, 'stop', { hook_event_name: 'Stop', session_id: 'session-a' });

  const resumed = new ProjectState(dbPath);
  assert.equal(resumed.nextGoal().id, 'g2', 'the resumed context finds the right goal');
  resumed.completeGoal('g2', 'hooks + tests pass');
  const status = resumed.statusText();
  assert.match(status, /goals: 2\/3 completed \| pending 0/);
  assert.match(status, /\[active\] g3 - docs/);
  resumed.close();
});

test('ordinary sessions stay quiet: repeated hooks do not pile up checkpoints', () => {
  const dbPath = freshPath();
  seedWork(dbPath);

  runHook(dbPath, 'stop', { hook_event_name: 'Stop', session_id: 'session-a' });
  const second = runHook(dbPath, 'stop', { hook_event_name: 'Stop', session_id: 'session-a' });
  assert.match(second, /checkpoint unchanged/);

  const store = new ProjectState(dbPath);
  assert.equal(store.lastCheckpoint().payload.next_action, 'continue g2: hooks');

  // Real progress does move the checkpoint forward.
  store.completeGoal('g2', 'hooks tests pass');
  store.checkpoint({});
  const rows = store.db.prepare('SELECT payload FROM checkpoints ORDER BY seq').all();
  assert.equal(rows.length, 2, 'one checkpoint per change, not per hook call');
  assert.match(JSON.parse(rows[1].payload).next_action, /g3: docs/);
  store.close();
});

test('prompt-submit injects once per context and stays silent afterwards', () => {
  const dbPath = freshPath();
  seedWork(dbPath);

  const first = JSON.parse(runHook(dbPath, 'prompt-submit', { hook_event_name: 'UserPromptSubmit', session_id: 'session-a' }));
  assert.equal(first.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.match(first.hookSpecificOutput.additionalContext, /next action: continue g2: hooks/);

  const again = runHook(dbPath, 'prompt-submit', { hook_event_name: 'UserPromptSubmit', session_id: 'session-a' });
  assert.equal(again.trim(), '', 'the same context is not re-injected on every prompt');

  const fresh = JSON.parse(runHook(dbPath, 'session-start', { hook_event_name: 'SessionStart', session_id: 'session-b' }));
  assert.match(fresh.hookSpecificOutput.additionalContext, /current goal: g2: hooks/);
});

test('an empty store produces no checkpoint at all', () => {
  const store = new ProjectState(freshPath());
  store.init({ objective: 'nothing done yet' });
  assert.equal(store.checkpoint({}), null);
  assert.equal(store.lastCheckpoint(), null);
  assert.equal(handleHook('Stop', store, {}), 'checkpoint skipped: nothing tracked yet');
  store.close();
});

test('hook labels from Harness map onto the three behaviours', () => {
  assert.equal(normalizeEvent('Stop'), 'stop');
  assert.equal(normalizeEvent('SessionStart'), 'session-start');
  assert.equal(normalizeEvent('UserPromptSubmit'), 'prompt-submit');
  assert.equal(normalizeEvent('SubagentStop'), 'stop');
  assert.equal(
    JSON.parse(hookOutput('Stop', 'body')).hookSpecificOutput.additionalContext,
    'body'
  );
});

test('shipped hook config wires the three events to this server', () => {
  const config = JSON.parse(readFileSync(new URL('../hooks.json', import.meta.url), 'utf8'));
  const events = Object.keys(config.hooks).sort();
  assert.deepEqual(events, ['SessionStart', 'Stop', 'UserPromptSubmit']);
  for (const groups of Object.values(config.hooks)) {
    for (const group of groups) {
      for (const hook of group.hooks) {
        assert.equal(hook.type, 'command');
        assert.match(hook.command, /src\/server\.js hook (stop|session-start|prompt-submit)/);
        assert.ok(hook.command.startsWith('/') || hook.command.includes('${CLAUDE_PROJECT_DIR}'), 'absolute or substituted path');
      }
    }
  }
});
