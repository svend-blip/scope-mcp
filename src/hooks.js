/**
 * Harness hook handlers: the two automatic behaviours around context loss.
 *
 * `Stop` -> persist the working position before useful context may be compacted.
 * `SessionStart` / `UserPromptSubmit` -> inject the resume brief into the fresh
 * context so the agent continues from the recorded next action on its own.
 *
 * Harness runs each hook as a command with its payload on stdin and decodes the
 * outcome from stdout, so these handlers only read a payload and build strings:
 * no daemon, no scheduler, no polling.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
// zstd arrived in node:zlib with Node 22.15; on an older Node the child check is simply skipped.
import * as zlib from 'node:zlib';

/** Harness event labels, matched case-insensitively against CLI arguments. */
const SESSION_START = new Set(['session-start', 'sessionstart']);
const PROMPT_SUBMIT = new Set(['prompt-submit', 'promptsubmit', 'userpromptsubmit', 'user-prompt-submit']);

/** Map a CLI argument or stdin label onto one of the three behaviours. */
export function normalizeEvent(name = '') {
  const key = String(name).toLowerCase().replace(/[^a-z-]/g, '');
  if (SESSION_START.has(key)) return 'session-start';
  if (PROMPT_SUBMIT.has(key)) return 'prompt-submit';
  return 'stop';
}

/** Read the hook payload Harness writes to stdin; missing or odd input is fine. */
export function readStdinPayload(fd = 0) {
  try {
    const parsed = JSON.parse(readFileSync(fd, 'utf8') || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/** Identity used to inject a resume brief at most once per context. */
export function sessionKey(payload = {}) {
  return String(payload.session_id || process.env.DSH_SESSION_ID || payload.cwd || 'default');
}

/**
 * Whether a DSH session is a delegated child (a workflow or subagent run).
 * Children get their task from their parent, not from the project state: a
 * resume brief appended after that task hijacks it, and their checkpoints
 * would overwrite the project's working position. The session header DSH
 * writes says so (`origin: "subagent"` / `delegationDepth > 0`); a session
 * that cannot be found is treated as top level.
 */
export function isDelegatedChild(sessionId, sessionsDir = join(homedir(), '.dsh', 'sessions')) {
  const id = String(sessionId || '');
  if (typeof zlib.zstdDecompressSync !== 'function') return false;
  if (!id || id.includes('/') || id.includes('\\')) return false;
  let workspaces;
  try {
    workspaces = readdirSync(sessionsDir);
  } catch {
    return false;
  }
  for (const ws of workspaces) {
    // DSH 0.2.x writes session.v4 (same header fields) and leaves a migrated session's v3 behind.
    let raw;
    for (const name of ['session.v4.jsonl.zstd', 'session.v3.jsonl.zstd']) {
      try {
        raw = readFileSync(join(sessionsDir, ws, id, name));
        break;
      } catch {
        raw = undefined;
      }
    }
    if (raw === undefined) continue;
    try {
      const text = zlib.zstdDecompressSync(raw).toString('utf8');
      const first = JSON.parse(text.slice(0, text.indexOf('\n') === -1 ? undefined : text.indexOf('\n')));
      const header = first.header ?? first;
      return header.origin === 'subagent' || Number(header.delegationDepth) > 0;
    } catch {
      return false;
    }
  }
  return false;
}

/** Wrap text in the structured stdout shape Harness decodes. */
export function hookOutput(eventName, context) {
  return JSON.stringify({ hookSpecificOutput: { hookEventName: eventName, additionalContext: context } });
}

/**
 * Run one hook behaviour against a store and return what to print on stdout.
 * An empty return means "nothing to add", which Harness treats as a no-op.
 */
export function handleHook(event, store, payload = {}) {
  const behaviour = normalizeEvent(event);

  if (behaviour === 'stop') {
    const cp = store.checkpoint({});
    if (!cp) return 'checkpoint skipped: nothing tracked yet';
    if (cp.unchanged) return `checkpoint unchanged (${cp.at})`;
    const { current_goal: goal, next_action: next } = cp.payload;
    const focus = goal && next && goal !== next ? `${goal} -> ${next}` : next || goal || '(no goal recorded)';
    return `checkpoint ${cp.at}: ${focus}`;
  }

  const key = sessionKey(payload);
  if (behaviour === 'prompt-submit' && store.meta('resume_brief_for') === key) return '';

  store.setMeta('resume_brief_for', key);
  const label = behaviour === 'session-start' ? 'SessionStart' : 'UserPromptSubmit';
  return hookOutput(label, store.resumeBrief());
}
