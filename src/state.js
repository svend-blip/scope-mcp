/**
 * Durable project state for scope-mcp.
 *
 * One SQLite file per workspace. Plain tables, deterministic transitions, no
 * planning logic: this module stores and reports, the model reasons.
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const GOAL_STATUSES = ['pending', 'active', 'completed', 'blocked'];
export const COVERAGE_STATUSES = ['fulfilled', 'deferred', 'missing'];

/** How many checkpoint rows to keep; older ones carry nothing a resume needs. */
export const CHECKPOINT_KEEP = 50;

/** Expand a leading `~` the way Harness does, using the platform home. */
export function expandHomePath(value) {
  const text = String(value);
  if (text === '~') return homedir();
  if (text.startsWith('~/') || text.startsWith('~\\')) return join(homedir(), text.slice(2));
  return text;
}

/** Where the state file lives for this workspace: one file per workspace. */
export function defaultDbPath(cwd = process.cwd()) {
  const fromEnv = process.env.SCOPE_MCP_DB;
  if (fromEnv) return expandHomePath(fromEnv);
  return join(expandHomePath(cwd), '.scope-mcp', 'state.db');
}

function now() {
  return new Date().toISOString();
}

/** Keep injected one-liners short without losing the point. */
function truncate(value, max) {
  const text = String(value);
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export class ProjectState {
  constructor(dbPath = defaultDbPath()) {
    if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(
      'PRAGMA journal_mode = WAL;' +
        'PRAGMA synchronous = FULL;' +
        `CREATE TABLE IF NOT EXISTS meta (
             key TEXT PRIMARY KEY, value TEXT NOT NULL);
         CREATE TABLE IF NOT EXISTS goals (
             id TEXT PRIMARY KEY,
             seq INTEGER NOT NULL,
             title TEXT NOT NULL,
             description TEXT NOT NULL DEFAULT '',
             status TEXT NOT NULL CHECK (status IN ('pending','active','completed','blocked')),
             validation TEXT NOT NULL DEFAULT '',
             completed_at TEXT NOT NULL DEFAULT '');
         CREATE TABLE IF NOT EXISTS decisions (
             seq INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, text TEXT NOT NULL);
         CREATE TABLE IF NOT EXISTS blockers (
             seq INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, text TEXT NOT NULL,
             resolved_at TEXT NOT NULL DEFAULT '');
         CREATE TABLE IF NOT EXISTS coverage (
             requirement TEXT PRIMARY KEY, status TEXT NOT NULL, note TEXT NOT NULL DEFAULT '',
             at TEXT NOT NULL);
         CREATE TABLE IF NOT EXISTS checkpoints (
             seq INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, payload TEXT NOT NULL);
         CREATE TABLE IF NOT EXISTS scope_docs (
             seq INTEGER PRIMARY KEY AUTOINCREMENT,
             kind TEXT NOT NULL CHECK (kind IN ('base','addendum')),
             at TEXT NOT NULL,
             title TEXT NOT NULL DEFAULT '',
             text TEXT NOT NULL,
             active INTEGER NOT NULL DEFAULT 1);`
    );
  }

  close() {
    this.db.close();
  }

  // ---- meta -------------------------------------------------------------

  meta(key) {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
    return row ? row.value : null;
  }

  setMeta(key, value) {
    this.db
      .prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, String(value));
  }

  /** Create the project record from an accepted scope. Idempotent. */
  init({ objective, scopeFile = 'SCOPE.md', reset = false } = {}) {
    if (reset) {
      this.db.exec(
        'DELETE FROM goals; DELETE FROM decisions; DELETE FROM blockers; DELETE FROM coverage; DELETE FROM checkpoints;'
      );
      this.db.exec("DELETE FROM meta WHERE key <> 'initialized_at';");
    }
    if (objective) this.setMeta('objective', objective);
    if (scopeFile) this.setMeta('scope_file', scopeFile);
    if (!this.meta('initialized_at')) this.setMeta('initialized_at', now());
    this.setMeta('scope_status', 'accepted');
    return this.statusText();
  }

  // ---- scope documents --------------------------------------------------

  /** Active scope documents in accepted order: the base first, then addenda. */
  scopeDocs() {
    return this.db.prepare('SELECT * FROM scope_docs WHERE active = 1 ORDER BY seq').all();
  }

  baseScope() {
    return this.db.prepare("SELECT * FROM scope_docs WHERE active = 1 AND kind = 'base' ORDER BY seq DESC LIMIT 1").get() ?? null;
  }

  /** Record the accepted base scope. A later base supersedes earlier records. */
  recordScope({ text, title = '' } = {}) {
    if (!text) throw new Error('record_scope needs the accepted base scope text');
    this.db.prepare('UPDATE scope_docs SET active = 0 WHERE active = 1').run();
    this.db
      .prepare("INSERT INTO scope_docs (kind, at, title, text) VALUES ('base', ?, ?, ?)")
      .run(now(), String(title), String(text));
    return this.db.prepare('SELECT * FROM scope_docs ORDER BY seq DESC LIMIT 1').get();
  }

  /** Append one accepted addendum below the current base scope, in order. */
  addScopeAddendum({ text, title = '' } = {}) {
    if (!text) throw new Error('add_scope_addendum needs the accepted addendum text');
    if (!this.baseScope()) throw new Error('add_scope_addendum needs a base scope first: call record_scope');
    this.db
      .prepare("INSERT INTO scope_docs (kind, at, title, text) VALUES ('addendum', ?, ?, ?)")
      .run(now(), String(title), String(text));
    // New intent makes the old completion check stale: reopen it for
    // re-evaluation. Goals and coverage stay as they are - the model decides
    // what still applies.
    if (this.isComplete()) {
      this.setMeta('scope_status', 'accepted');
      this.db.prepare("DELETE FROM meta WHERE key = 'completed_at'").run();
    }
    return this.db.prepare('SELECT * FROM scope_docs ORDER BY seq DESC LIMIT 1').get();
  }

  /**
   * The effective scope: base scope followed by its accepted addenda in order.
   * Interpretation and reconciliation of conflicts stay with the model.
   */
  effectiveScope() {
    const base = this.baseScope();
    if (!base) return null;
    const addenda = this.db
      .prepare("SELECT * FROM scope_docs WHERE active = 1 AND kind = 'addendum' AND seq > ? ORDER BY seq")
      .all(base.seq);
    const blocks = [{ doc: base, label: 'base' }, ...addenda.map((doc) => ({ doc, label: 'addendum' }))];
    const text = blocks
      .map(({ doc, label }) => `[#${doc.seq}] ${label} accepted ${doc.at}${doc.title ? ` - ${doc.title}` : ''}\n${doc.text}`)
      .join('\n\n');
    return { base, addenda, text };
  }

  /** Counts only - what intent exists, not what it says. For status and doctor. */
  scopeMetadata() {
    const base = this.baseScope();
    const addenda = this.db.prepare("SELECT COUNT(*) AS n FROM scope_docs WHERE active = 1 AND kind = 'addendum'").get().n;
    const latest = this.db.prepare('SELECT seq FROM scope_docs WHERE active = 1 ORDER BY seq DESC LIMIT 1').get();
    return { recorded: Boolean(base), addenda, latest: latest ? latest.seq : null };
  }

  /** One-line summary of the durable intent, for status and resume briefs. */
  scopeSummary() {
    const scope = this.effectiveScope();
    if (!scope) {
      const file = this.meta('scope_file');
      return file ? `not recorded here - read ${file}` : 'none recorded';
    }
    const latest = scope.addenda.at(-1) ?? scope.base;
    return `${scope.addenda.length} addendum(s) after the base scope, latest #${latest.seq} accepted ${latest.at}`
      + `${latest.title ? ` (${latest.title})` : ''} - read the effective scope before continuing`;
  }

  // ---- goals ------------------------------------------------------------

  goalRows() {
    return this.db.prepare('SELECT * FROM goals ORDER BY seq, id').all();
  }

  activeGoalRow() {
    return this.db.prepare("SELECT * FROM goals WHERE status = 'active' ORDER BY seq, id").all()[0] ?? null;
  }

  /** Promote the first pending goal to active when nothing is active. */
  ensureActiveGoal() {
    if (this.activeGoalRow()) return;
    const next = this.db.prepare("SELECT id FROM goals WHERE status = 'pending' ORDER BY seq, id").get();
    if (next) this.db.prepare("UPDATE goals SET status = 'active' WHERE id = ?").run(next.id);
  }

  /** Replace the goal list, preserving recorded status for known ids. */
  setGoals(goals = []) {
    const seen = new Set();
    goals.forEach((goal, index) => {
      if (!goal || !goal.id || !goal.title) throw new Error('each goal needs an id and a title');
      const status = GOAL_STATUSES.includes(goal.status ?? '') ? goal.status : 'pending';
      this.db
        .prepare(
          `INSERT INTO goals (id, seq, title, description, status, validation, completed_at)
           VALUES (?, ?, ?, ?, ?, '', '')
           ON CONFLICT(id) DO UPDATE SET
             seq = excluded.seq, title = excluded.title, description = excluded.description`
        )
        .run(String(goal.id), index, String(goal.title), String(goal.description ?? ''), status);
      seen.add(String(goal.id));
    });
    // Drop listed-order info for goals no longer in the list, keeping history.
    for (const row of this.goalRows()) {
      if (seen.has(row.id) || row.status === 'completed') continue;
      this.db.prepare('DELETE FROM goals WHERE id = ?').run(row.id);
    }
    this.ensureActiveGoal();
    return this.goalRows();
  }

  /** Return the current goal, promoting the first pending one if needed. */
  nextGoal(id) {
    if (id) {
      const row = this.db.prepare('SELECT * FROM goals WHERE id = ?').get(String(id));
      if (!row) throw new Error(`unknown goal id: ${id}`);
      if (row.status !== 'completed') {
        const active = this.activeGoalRow();
        if (active && active.id !== row.id) this.db.prepare("UPDATE goals SET status = 'pending' WHERE id = ?").run(active.id);
        this.db.prepare("UPDATE goals SET status = 'active' WHERE id = ?").run(row.id);
      }
      return this.db.prepare('SELECT * FROM goals WHERE id = ?').get(String(id));
    }
    const active = this.activeGoalRow();
    if (active) return active;
    this.ensureActiveGoal();
    return this.activeGoalRow();
  }

  completeGoal(id, validation, notes = '') {
    const row = this.db.prepare('SELECT * FROM goals WHERE id = ?').get(String(id));
    if (!row) throw new Error(`unknown goal id: ${id}`);
    if (!validation) throw new Error('complete_goal needs validation evidence');
    this.db
      .prepare("UPDATE goals SET status = 'completed', validation = ?, completed_at = ? WHERE id = ?")
      .run(String(validation), now(), String(id));
    if (notes) this.addDecision(`note for ${id}: ${notes}`);
    this.ensureActiveGoal();
    return this.db.prepare('SELECT * FROM goals WHERE id = ?').get(String(id));
  }

  /** Mark a goal blocked (an unresolved issue against a specific goal). */
  blockGoal(id, reason) {
    const row = this.db.prepare('SELECT * FROM goals WHERE id = ?').get(String(id));
    if (!row) throw new Error(`unknown goal id: ${id}`);
    if (row.status !== 'completed') this.db.prepare("UPDATE goals SET status = 'blocked' WHERE id = ?").run(String(id));
    if (reason) this.addBlocker(`${id}: ${reason}`);
    this.ensureActiveGoal();
    return this.db.prepare('SELECT * FROM goals WHERE id = ?').get(String(id));
  }

  validations() {
    return this.db
      .prepare("SELECT id, validation FROM goals WHERE status = 'completed' AND validation <> '' ORDER BY seq, id")
      .all();
  }

  // ---- decisions and blockers -------------------------------------------

  addDecision(text) {
    if (!text) throw new Error('record_decision needs text');
    this.db.prepare('INSERT INTO decisions (at, text) VALUES (?, ?)').run(now(), String(text));
    return this.db.prepare('SELECT * FROM decisions ORDER BY seq DESC LIMIT 1').get();
  }

  decisions(limit = 8) {
    return this.db.prepare('SELECT * FROM decisions ORDER BY seq DESC LIMIT ?').all(limit);
  }

  addBlocker(text) {
    if (!text) throw new Error('record_blocker needs text');
    this.db.prepare('INSERT INTO blockers (at, text) VALUES (?, ?)').run(now(), String(text));
    return this.db.prepare('SELECT * FROM blockers ORDER BY seq DESC LIMIT 1').get();
  }

  resolveBlocker(seq) {
    const row = this.db.prepare('SELECT * FROM blockers WHERE seq = ?').get(Number(seq));
    if (!row) throw new Error(`unknown blocker: ${seq}`);
    this.db.prepare('UPDATE blockers SET resolved_at = ? WHERE seq = ?').run(now(), Number(seq));
    return this.db.prepare('SELECT * FROM blockers WHERE seq = ?').get(Number(seq));
  }

  openBlockers() {
    return this.db.prepare("SELECT * FROM blockers WHERE resolved_at = '' ORDER BY seq").all();
  }

  // ---- coverage ---------------------------------------------------------

  setCoverage(items = []) {
    for (const item of items) {
      if (!item || !item.requirement) throw new Error('coverage item needs a requirement');
      const status = COVERAGE_STATUSES.includes(item.status ?? '') ? item.status : 'missing';
      this.db
        .prepare(
          `INSERT INTO coverage (requirement, status, note, at) VALUES (?, ?, ?, ?)
           ON CONFLICT(requirement) DO UPDATE SET status = excluded.status, note = excluded.note, at = excluded.at`
        )
        .run(String(item.requirement), status, String(item.note ?? ''), now());
    }
    return this.coverageRows();
  }

  coverageRows() {
    return this.db.prepare('SELECT * FROM coverage ORDER BY requirement').all();
  }

  coverageSummary() {
    const counts = { fulfilled: 0, deferred: 0, missing: 0 };
    for (const row of this.coverageRows()) counts[row.status] += 1;
    return counts;
  }

  // ---- checkpoints ------------------------------------------------------

  /** True when something meaningful is recorded, so a checkpoint would say something. */
  hasTrackedWork() {
    const any = (sql) => this.db.prepare(sql).get() !== undefined;
    return Boolean(
      any('SELECT 1 FROM goals LIMIT 1') ||
        any('SELECT 1 FROM decisions LIMIT 1') ||
        any("SELECT 1 FROM blockers WHERE resolved_at = '' LIMIT 1") ||
        any('SELECT 1 FROM coverage LIMIT 1') ||
        any('SELECT 1 FROM scope_docs WHERE active = 1 LIMIT 1')
    );
  }

  /** Deterministic next action for checkpoints that arrive without explicit fields. */
  derivedNextAction() {
    const active = this.activeGoalRow();
    const stored = this.meta('next_action');
    // A stored instruction survives while it still fits the current goal; the
    // auto form is refreshed whenever the active goal moves on.
    if (stored && (!active || stored.includes(active.id) || !stored.startsWith('continue '))) return stored;
    if (active) return `continue ${active.id}: ${active.title}`;
    if (this.goalRows().length) return 'record coverage for the remaining scope requirements, then complete_project';
    return stored ?? '';
  }

  /**
   * Snapshot the working position. Missing fields are derived from stored state.
   * An empty store writes nothing, and a snapshot identical to the previous one
   * reuses it, so hook-driven checkpoints stay cheap in ordinary short sessions.
   */
  checkpoint(fields = {}) {
    const active = this.activeGoalRow();
    const payload = {
      current_goal: fields.current_goal ?? (active ? `${active.id}: ${active.title}` : this.meta('next_action') ?? ''),
      work_completed: fields.work_completed ?? this.validations().map((v) => `${v.id}: ${v.validation}`).join('; '),
      important_decisions: fields.important_decisions ?? this.decisions(5).map((d) => d.text).join('; '),
      validation_state: fields.validation_state ?? this.validationState(),
      unresolved_issues: fields.unresolved_issues ?? this.openBlockers().map((b) => b.text).join('; '),
      next_action: fields.next_action ?? this.derivedNextAction()
    };

    const previous = this.lastCheckpoint();
    if (previous && JSON.stringify(previous.payload) === JSON.stringify(payload)) {
      return { ...previous, unchanged: true };
    }
    const meaningful = ['current_goal', 'work_completed', 'important_decisions', 'unresolved_issues', 'next_action'].some(
      (key) => payload[key]
    );
    if (!meaningful && !this.hasTrackedWork()) return null;

    this.db.prepare('INSERT INTO checkpoints (at, payload) VALUES (?, ?)').run(now(), JSON.stringify(payload));
    this.db
      .prepare('DELETE FROM checkpoints WHERE seq <= (SELECT MAX(seq) FROM checkpoints) - ?')
      .run(CHECKPOINT_KEEP);
    this.setMeta('next_action', payload.next_action);
    return { at: this.lastCheckpointAt(), payload };
  }

  lastCheckpointAt() {
    return this.db.prepare('SELECT at FROM checkpoints ORDER BY seq DESC LIMIT 1').get()?.at ?? null;
  }

  lastCheckpoint() {
    const row = this.db.prepare('SELECT * FROM checkpoints ORDER BY seq DESC LIMIT 1').get();
    if (!row) return null;
    return { at: row.at, payload: JSON.parse(row.payload) };
  }

  // ---- completion -------------------------------------------------------

  validationState() {
    const rows = this.validations();
    if (!rows.length) return 'none recorded';
    return rows.map((r) => `${r.id}=${r.validation}`).join(', ');
  }

  /**
   * Guardrail for scope coverage: complete only when every goal is done and
   * every recorded requirement is fulfilled or deferred. Reports what is left
   * otherwise. No reasoning here, only set comparison.
   */
  completeProject({ force = false } = {}) {
    const goals = this.goalRows();
    const openGoals = goals.filter((g) => g.status !== 'completed').map((g) => `${g.id}: ${g.title}`);
    const coverage = this.coverageRows();
    const gaps = coverage.filter((c) => c.status === 'missing').map((c) => c.requirement);
    const deferred = coverage.filter((c) => c.status === 'deferred').map((c) => c.requirement);
    const blockers = this.openBlockers().map((b) => b.text);

    // Coverage has to speak to the current effective scope: intent accepted after
    // the last coverage pass needs a fresh look, so completion waits for it.
    const latestScope = this.scopeMetadata().latest
      ? this.db.prepare('SELECT MAX(at) AS at FROM scope_docs WHERE active = 1').get()?.at ?? ''
      : '';
    const latestCoverage = coverage.length ? this.db.prepare('SELECT MAX(at) AS at FROM coverage').get()?.at ?? '' : '';
    const staleCoverage = Boolean(latestScope && latestCoverage && latestCoverage < latestScope);

    const ready = coverage.length > 0 && openGoals.length === 0 && gaps.length === 0 && !staleCoverage;

    if (!ready && !force) {
      const missing = [];
      if (coverage.length === 0) missing.push('no scope coverage recorded yet');
      if (staleCoverage) missing.push('coverage predates the latest accepted scope document - re-check it against the effective scope');
      missing.push(...openGoals.map((g) => `unfinished goal - ${g}`));
      missing.push(...gaps.map((g) => `gap - ${g}`));
      return { complete: false, missing, deferred, blockers, validation: this.validationState() };
    }

    this.setMeta('completed_at', now());
    this.setMeta('scope_status', 'complete');
    return { complete: true, missing: [], deferred, blockers, validation: this.validationState() };
  }

  isComplete() {
    return this.meta('scope_status') === 'complete';
  }

  // ---- reporting --------------------------------------------------------

  /**
   * Compact resume block for automatic injection into a fresh context: goal,
   * next action, progress, blockers. Fewer lines than `statusText`, same source.
   */
  resumeBrief({ decisions = 3 } = {}) {
    const active = this.activeGoalRow();
    const cp = this.lastCheckpoint();
    const lines = [];
    const objective = this.meta('objective');
    if (objective) lines.push(`objective: ${truncate(objective, 160)}`);
    if (this.baseScope()) {
      lines.push(`effective scope: ${this.scopeSummary()}`);
      lines.push('retrieve it with get_effective_scope before project-level decisions.');
    }
    lines.push(`current goal: ${active ? `${active.id}: ${active.title}` : this.goalRows().length ? '(none active)' : '(none)'}`);
    const next = cp?.payload.next_action || this.derivedNextAction();
    lines.push(`next action: ${next || '(unset - read the effective scope, then call status)'}`);
    const done = this.validations();
    lines.push(`completed: ${done.length ? done.map((v) => `${v.id} (${v.validation})`).join(', ') : '(nothing yet)'}`);
    const blockers = this.openBlockers();
    if (blockers.length) lines.push(`blockers: ${blockers.map((b) => b.text).join('; ')}`);
    const decided = this.decisions(decisions);
    if (decided.length) lines.push(`decisions: ${decided.map((d) => d.text).join('; ')}`);
    lines.push(`checkpoint: ${cp ? cp.at : '(none)'}`);
    lines.push('continue autonomously from the next action; call scope-mcp status for the full position.');
    return lines.join('\n');
  }

  /** Human-readable working position. This is the resume surface. */
  statusText({ decisions = 8 } = {}) {
    const lines = [];
    const goals = this.goalRows();
    const counts = { pending: 0, active: 0, completed: 0, blocked: 0 };
    for (const g of goals) counts[g.status] += 1;
    const active = this.activeGoalRow();

    lines.push(`objective: ${this.meta('objective') ?? '(none)'}`);
    lines.push(`scope: ${this.meta('scope_file') ?? 'SCOPE.md'} | status: ${this.meta('scope_status') ?? 'not initialized'}`);
    const meta = this.scopeMetadata();
    lines.push(
      `scope documents: ${meta.recorded ? `base recorded, addenda: ${meta.addenda}` : 'none recorded - read the scope file'}` +
        `${meta.latest ? ` | effective revision: #${meta.latest}` : ''}`
    );
    lines.push(`effective scope: ${this.scopeSummary()}`);
    lines.push(`goals: ${counts.completed}/${goals.length} completed | pending ${counts.pending} | blocked ${counts.blocked}`);
    lines.push(`current goal: ${active ? `${active.id}: ${active.title}` : goals.length ? '(none active)' : '(none)'}`);
    lines.push(`validation: ${this.validationState()}`);
    const cov = this.coverageSummary();
    lines.push(`coverage: ${cov.fulfilled} fulfilled, ${cov.deferred} deferred, ${cov.missing} missing`);
    lines.push(`completed at: ${this.meta('completed_at') ?? '(not complete)'}`);

    lines.push('');
    lines.push('goals:');
    if (!goals.length) lines.push('  (none)');
    for (const g of goals) lines.push(`  [${g.status}] ${g.id} - ${g.title}${g.validation ? ` (${g.validation})` : ''}`);

    const blockers = this.openBlockers();
    lines.push('');
    lines.push(`blockers (${blockers.length}):`);
    if (!blockers.length) lines.push('  (none)');
    for (const b of blockers) lines.push(`  #${b.seq} ${b.text}`);

    const decided = this.decisions(decisions).slice().reverse();
    lines.push('');
    lines.push('decisions:');
    if (!decided.length) lines.push('  (none)');
    for (const d of decided) lines.push(`  ${d.text}`);

    const docs = this.scopeDocs();
    if (docs.length) {
      lines.push('');
      lines.push('accepted scope documents, in order:');
      for (const doc of docs) lines.push(`  #${doc.seq} ${doc.kind} accepted ${doc.at}${doc.title ? ` - ${doc.title}` : ''}`);
    }

    const cp = this.lastCheckpoint();
    lines.push('');
    lines.push(`last checkpoint: ${cp ? cp.at : '(none)'}`);
    if (cp) {
      lines.push(`  next action: ${cp.payload.next_action || '(unset)'}`);
      lines.push(`  unresolved issues: ${cp.payload.unresolved_issues || '(none)'}`);
    }

    return lines.join('\n');
  }
}
