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
