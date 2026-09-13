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
import { readFileSync } from 'node:fs';

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
