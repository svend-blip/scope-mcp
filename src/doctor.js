/**
 * Read-only runtime diagnostics: what this process can actually see.
 *
 * Reports the facts an integrating agent needs to choose an integration level -
 * runtime capability, resolved paths, discovered Harness roots. Never writes
 * Harness configuration; the only filesystem action is making sure the own
 * state directory exists, exactly as the server would.
 */
import { accessSync, constants, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { defaultDbPath, expandHomePath } from './state.js';

/** Directory holding this package, resolved from the module itself. */
export function packageRoot() {
  return resolve(fileURLToPath(new URL('..', import.meta.url)));
}

function version() {
  try {
    return JSON.parse(readFileSync(join(packageRoot(), 'package.json'), 'utf8')).version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

/** Harness-injected variables worth reporting when present. */
export function harnessEnvironment(env = process.env) {
  const keys = ['DSH_HOME', 'DSH_SESSION_ID', 'DSH_SHELL', 'DSH_AGENTS_HOME', 'DSH_WEB_URL', 'SCOPE_MCP_DB', 'CLAUDE_PROJECT_DIR'];
  const found = {};
  for (const key of keys) if (env[key]) found[key] = env[key];
  return found;
}

/** Skill roots the installed Harness version is known to scan, existing ones first. */
export function discoveredSkillRoots(env = process.env, cwd = process.cwd()) {
  const home = env.DSH_HOME ? expandHomePath(env.DSH_HOME) : join(homedir(), '.dsh');
  const agents = env.DSH_AGENTS_HOME ? expandHomePath(env.DSH_AGENTS_HOME) : join(homedir(), '.agents');
  const candidates = [join(cwd, '.dsh', 'skills'), join(cwd, '.agents', 'skills'), join(home, 'skills'), join(agents, 'skills')];
  return candidates.filter((dir) => existsSync(dir));
}

/** Profiles shipped or created under the harness home. */
export function discoveredProfiles(env = process.env) {
  const home = env.DSH_HOME ? expandHomePath(env.DSH_HOME) : join(homedir(), '.dsh');
  const dir = join(home, 'profiles');
  if (!existsSync(dir)) return { dir, profiles: [] };
  let names = [];
  try {
    names = readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name !== 'node_modules')
      .map((entry) => entry.name);
  } catch {
    names = [];
  }
  return { dir, profiles: names };
}

/** Can this workspace hold a state file? */
function writeCheck(statePath) {
  const dir = dirname(statePath);
  try {
    mkdirSync(dir, { recursive: true });
    accessSync(dir, constants.W_OK);
    return `writable (${dir})`;
  } catch (error) {
    return `not writable (${dir}): ${error instanceof Error ? error.message : String(error)}`;
  }
}

/** What durable state already exists here. Read-only: opens the file without writing. */
function projectSummary(statePath) {
  if (!existsSync(statePath)) return 'none yet - call init_project when this workspace starts';
  let db;
  try {
    db = new DatabaseSync(statePath, { readOnly: true });
  } catch {
    return 'present (opened by the server at runtime)';
  }
  try {
    const has = (table) => db.prepare('SELECT 1 FROM sqlite_master WHERE type = ? AND name = ?').get('table', table) !== undefined;
    if (!has('meta')) return 'none yet - call init_project when this workspace starts';
    const meta = (key) => db.prepare('SELECT value FROM meta WHERE key = ?').get(key)?.value ?? null;
    const count = (sql) => db.prepare(sql).get().n;
    const docs = has('scope_docs') ? count('SELECT COUNT(*) AS n FROM scope_docs WHERE active = 1') : 0;
    const addenda = has('scope_docs') ? count("SELECT COUNT(*) AS n FROM scope_docs WHERE active = 1 AND kind = 'addendum'") : 0;
    const latest = has('scope_docs') ? db.prepare('SELECT seq FROM scope_docs WHERE active = 1 ORDER BY seq DESC LIMIT 1').get()?.seq : null;
    const goals = has('goals') ? count('SELECT COUNT(*) AS n FROM goals') : 0;
    const done = has('goals') ? count("SELECT COUNT(*) AS n FROM goals WHERE status = 'completed'") : 0;
    const checkpoint = has('checkpoints') ? db.prepare('SELECT at FROM checkpoints ORDER BY seq DESC LIMIT 1').get()?.at : null;
    return [
      meta('objective') ? 'initialized' : 'tables exist, no objective yet',
      `scope documents: ${docs ? `base${addenda ? ` + ${addenda} addenda` : ''}, latest #${latest}` : 'none recorded'}`,
      `goals: ${done}/${goals} completed`,
      `checkpoint: ${checkpoint ?? '(none)'}`
    ].join(' | ');
  } catch {
    return 'present but unreadable';
  } finally {
    db.close();
  }
}

/** Text report for `scope-mcp doctor`. */
export function doctorReport() {
  const statePath = defaultDbPath();
  const profiles = discoveredProfiles();
  const roots = discoveredSkillRoots();
  const env = harnessEnvironment();
  const lines = [
    `scope-mcp ${version()}`,
    `node: ${process.version} (${process.execPath})`,
    `node:sqlite: ${typeof DatabaseSync === 'function' ? 'available' : 'MISSING - needs Node >= 22.5'}`,
    `package root: ${basename(packageRoot()) || packageRoot()} (${packageRoot()})`,
    `workspace: ${process.cwd()}`,
    `state file: ${statePath}`,
    `state dir: ${writeCheck(statePath)}`,
    `project state: ${projectSummary(statePath)}`,
    `harness home: ${env.DSH_HOME ? expandHomePath(env.DSH_HOME) : `${join(homedir(), '.dsh')} (default)`}`,
    `profiles at ${profiles.dir}: ${profiles.profiles.length ? profiles.profiles.join(', ') : '(none)'}`,
    `skill roots: ${roots.length ? roots.join(', ') : '(none existing)'}`
  ];
  for (const [key, value] of Object.entries(env)) lines.push(`env ${key}: ${value}`);
  lines.push(
    'levels: A = MCP + skills + lifecycle hooks; B = MCP + skills, manual checkpoint/resume; C = MCP tools only.',
    'checks: harness lists scope-mcp tools; hooks fire via the harness hooks bridge; skills appear in the skill catalog.'
  );
  return lines.join('\n');
}
