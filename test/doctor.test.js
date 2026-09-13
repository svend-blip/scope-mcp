import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { defaultDbPath, expandHomePath } from '../src/state.js';
import { discoveredProfiles, discoveredSkillRoots, doctorReport, harnessEnvironment, packageRoot } from '../src/doctor.js';

function tempRoot() {
  return mkdtempSync(join(tmpdir(), 'scope-mcp-doctor-'));
}

/** Run fn with a controlled environment, then restore it. */
function withEnv(extra, fn) {
  const saved = { ...process.env };
  for (const [key, value] of Object.entries(extra)) {
    if (value === void 0) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
}

test('state path is built from platform-aware path rules', () => {
  const root = tempRoot();
  const withSpace = join(root, 'My Project');
  mkdirSync(withSpace, { recursive: true });
  assert.equal(defaultDbPath(withSpace), join(withSpace, '.scope-mcp', 'state.db'));
  assert.equal(defaultDbPath(join(root, 'other')), join(root, 'other', '.scope-mcp', 'state.db'));
});

test('state location is the workspace, never the package location', () => {
  const workspace = join(tempRoot(), 'project-a');
  const resolved = defaultDbPath(workspace);
  assert.ok(resolved.startsWith(workspace), 'state follows the workspace');
  assert.ok(!resolved.startsWith(packageRoot()), 'state does not follow the package');
});

test('a leading tilde expands against the platform home', () => {
  assert.equal(expandHomePath('~'), homedir());
  assert.equal(expandHomePath(join('~', 'chosen.db')), join(homedir(), 'chosen.db'));
  assert.equal(expandHomePath(join('~', 'nested', 'chosen.db')), join(homedir(), 'nested', 'chosen.db'));
  assert.equal(expandHomePath(join(homedir(), 'already.abs')), join(homedir(), 'already.abs'));
});

test('SCOPE_MCP_DB overrides the workspace file and honours tildes', () => {
  const explicit = join(tempRoot(), 'chosen.db');
  assert.equal(withEnv({ SCOPE_MCP_DB: explicit }, () => defaultDbPath('/some/workspace')), explicit);
  assert.equal(withEnv({ SCOPE_MCP_DB: join('~', 'chosen.db') }, () => defaultDbPath('/some/workspace')), join(homedir(), 'chosen.db'));
  assert.equal(withEnv({ SCOPE_MCP_DB: void 0 }, () => defaultDbPath('/some/workspace')), join('/some/workspace', '.scope-mcp', 'state.db'));
});

test('only environment variables that exist are reported', () => {
  const found = harnessEnvironment({ DSH_HOME: '/home/u/.dsh', DSH_SESSION_ID: 's-1', EMPTY: '', MISSING: void 0 });
  assert.deepEqual(found, { DSH_HOME: '/home/u/.dsh', DSH_SESSION_ID: 's-1' });
});

test('skill roots and profiles are discovered from what exists', () => {
  const root = tempRoot();
  const workspace = join(root, 'ws');
  mkdirSync(join(workspace, '.agents', 'skills'), { recursive: true });
  mkdirSync(join(root, 'dshhome', 'skills'), { recursive: true });
  mkdirSync(join(root, 'dshhome', 'profiles', 'web'), { recursive: true });
  mkdirSync(join(root, 'dshhome', 'profiles', 'headless'), { recursive: true });

  const roots = discoveredSkillRoots({ DSH_HOME: join(root, 'dshhome'), DSH_AGENTS_HOME: join(root, 'missing') }, workspace);
  assert.deepEqual(roots, [join(workspace, '.agents', 'skills'), join(root, 'dshhome', 'skills')]);

  const profiles = discoveredProfiles({ DSH_HOME: join(root, 'dshhome') });
  assert.deepEqual(profiles.profiles.sort(), ['headless', 'web']);
  assert.equal(profiles.dir, join(root, 'dshhome', 'profiles'));

  const absent = discoveredProfiles({ DSH_HOME: join(root, 'nowhere') });
  assert.deepEqual(absent.profiles, [], 'a missing harness home is reported, not fatal');
});

test('doctor reports runtime capability, paths, and support levels without touching configuration', () => {
  const root = tempRoot();
  const dbPath = join(root, 'nest', 'doctor.db');
  mkdirSync(join(root, 'home', 'profiles', 'web'), { recursive: true });
  const out = withEnv({ SCOPE_MCP_DB: dbPath, DSH_HOME: join(root, 'home') }, () => doctorReport());

  assert.ok(out.includes(`node: ${process.version}`), 'node runtime reported');
  assert.match(out, /node:sqlite: available/);
  assert.ok(out.includes(`state file: ${dbPath}`), 'resolved state path reported');
  assert.match(out, /state dir: writable/);
  assert.ok(out.includes('profiles at'), 'discovered profiles listed');
  assert.match(out, /levels: A =.*B =.*C =/, 'support levels are stated');
  assert.ok(existsSync(dirname(dbPath)), 'doctor prepares only its own state directory');
  assert.equal(typeof DatabaseSync, 'function');
});

test('the active workspace decides where state goes', () => {
  const root = tempRoot();
  const workspace = join(root, 'Project With Spaces');
  mkdirSync(workspace, { recursive: true });
  const previous = process.cwd();
  try {
    process.chdir(workspace);
    const out = withEnv({ SCOPE_MCP_DB: void 0 }, () => doctorReport());
    assert.ok(out.includes(`workspace: ${workspace}`), 'doctor reports the launched directory');
    assert.ok(out.includes(join(workspace, '.scope-mcp', 'state.db')), 'state follows that directory');
  } finally {
    process.chdir(previous);
  }
});

test('hook commands resolve through harness substitution, not one machine path', () => {
  const config = JSON.parse(readFileSync(new URL('../hooks.json', import.meta.url), 'utf8'));
  for (const groups of Object.values(config.hooks)) {
    for (const group of groups) {
      for (const hook of group.hooks) {
        assert.match(hook.command, /\$\{CLAUDE_PLUGIN_ROOT\}/, 'package path comes from harness config');
        assert.ok(!hook.command.includes('/home/'), 'no hard-coded home directory');
        assert.match(hook.command, /(node|"\$?\{?CLAUDE_PLUGIN_ROOT)/);
      }
    }
  }
});

test('skills stay workspace-neutral', () => {
  for (const dir of ['save-checkpoint', 'resume-work']) {
    const text = readFileSync(new URL(`../skills/${dir}/SKILL.md`, import.meta.url), 'utf8');
    assert.ok(!text.includes('/home/'), `${dir}: no absolute home path`);
    assert.match(text, /current DeepSeek Harness workspace/, `${dir}: works from the active workspace`);
  }
});
