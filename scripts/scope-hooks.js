/**
 * Harness hook entry for scope-mcp (Claude Code bridge command hooks).
 *
 * Runs inside a DeepSeek Harness hook process with the session workspace as
 * its cwd, so the workspace state file is <cwd>/.scope-mcp/state.db (or
 * $SCOPE_MCP_DB when set). Speaks the Claude Code hook output JSON dialect.
 *
 *   node scripts/scope-hooks.js resume     -> SessionStart context injection
 *   node scripts/scope-hooks.js checkpoint -> Stop hook: snapshot if changed
 *   node scripts/scope-hooks.js marker     -> PostToolUse probe: log + exit
 *
 * Every invocation appends one diagnostic line to <cwd>/.scope-mcp/hooks.log.
 */
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { ProjectState, defaultDbPath } from '../src/state.js';

const [verb] = process.argv.slice(2);

function workspaceDbPath(payloadCwd) {
  if (process.env.SCOPE_MCP_DB) return process.env.SCOPE_MCP_DB;
  return defaultDbPath(payloadCwd ?? process.cwd());
}

function readPayload() {
  try {
    const raw = readFileSync(0, 'utf8');
    if (!raw.trim()) return {};
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function emit(output) {
  process.stdout.write(`${JSON.stringify(output)}\n`);
}

function failSafe(error) {
  // Hooks must never block a session: any failure is reported on stderr and
  // the run continues.
  process.stderr.write(`scope-mcp hook: ${String(error)}\n`);
  process.exit(0);
}

/** Append one diagnostic line proving the hook process ran. Never throws. */
function mark(verb, payload) {
  try {
    mkdirSync('.scope-mcp', { recursive: true });
    appendFileSync(
      '.scope-mcp/hooks.log',
      `${new Date().toISOString()} | ${verb} | hookCwd=${process.cwd()} | payloadCwd=${payload.cwd ?? ''}\n`
    );
  } catch {
    // diagnostics only
  }
}

const payload = readPayload();

if (verb === 'resume') {
  mark('resume', payload);
  try {
    const store = new ProjectState(workspaceDbPath(payload.cwd));
    try {
      if (!store.meta('objective')) {
        // Not a scope-mcp project (yet): inject nothing.
        emit({});
        process.exit(0);
      }
      const workspace = payload.cwd ?? process.cwd();
      const context = [
        `[scope-mcp resume] project state for workspace: ${workspace}`,
        store.statusText({ decisions: 8 }),
        `[scope-mcp resume] follow the resume-work skill: verify the current goal above, then call next_goal and continue. Pass workspace "${workspace}" to scope-mcp MCP tools.`
      ].join('\n');
      emit({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context } });
    } finally {
      store.close();
    }
  } catch (error) {
    failSafe(error);
  }
} else if (verb === 'checkpoint') {
  mark('checkpoint', payload);
  try {
    const store = new ProjectState(workspaceDbPath(payload.cwd));
    try {
      if (!store.meta('objective')) process.exit(0); // nothing tracked yet
      const candidate = store.deriveCheckpoint({});
      const last = store.lastCheckpoint();
      const unchanged = last !== null && JSON.stringify(last.payload) === JSON.stringify(candidate);
      if (!unchanged) store.checkpoint({});
    } finally {
      store.close();
    }
    emit({});
  } catch (error) {
    failSafe(error);
  }
} else if (verb === 'marker') {
  mark('marker', payload);
  emit({});
} else {
  process.stderr.write(`scope-mcp hook: unknown verb ${JSON.stringify(verb ?? '')} (expected resume|checkpoint|marker)\n`);
  process.exit(0);
}
