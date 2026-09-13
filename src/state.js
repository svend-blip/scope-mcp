/**
 * Durable project state for scope-mcp.
 *
 * One SQLite file per workspace. Plain tables, deterministic transitions, no
 * planning logic: this module stores and reports, the model reasons.
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const GOAL_STATUSES = ['pending', 'active', 'completed', 'blocked'];
export const COVERAGE_STATUSES = ['fulfilled', 'deferred', 'missing'];

/** Where the state file lives for this workspace. */
export function defaultDbPath(cwd = process.cwd()) {
  const fromEnv = process.env.SCOPE_MCP_DB;
  if (fromEnv) return fromEnv;
  return join(cwd, '.scope-mcp', 'state.db');
}

function now() {
  return new Date().toISOString();
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
             seq INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, payload TEXT NOT NULL);`
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

  /**
   * Derive the checkpoint payload for the current working position without
   * writing it. Missing fields are filled from stored state, exactly as
   * checkpoint() does before inserting.
   */
  deriveCheckpoint(fields = {}) {
    const active = this.activeGoalRow();
    return {
      current_goal: fields.current_goal ?? (active ? `${active.id}: ${active.title}` : this.meta('next_action') ?? ''),
      work_completed: fields.work_completed ?? this.validations().map((v) => `${v.id}: ${v.validation}`).join('; '),
      important_decisions: fields.important_decisions ?? this.decisions(5).map((d) => d.text).join('; '),
      validation_state: fields.validation_state ?? this.validationState(),
      unresolved_issues: fields.unresolved_issues ?? this.openBlockers().map((b) => b.text).join('; '),
      next_action: fields.next_action ?? this.meta('next_action') ?? ''
    };
  }

  /** Snapshot the working position. Missing fields are derived from state. */
  checkpoint(fields = {}) {
    const payload = this.deriveCheckpoint(fields);
    this.db.prepare('INSERT INTO checkpoints (at, payload) VALUES (?, ?)').run(now(), JSON.stringify(payload));
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
    const ready = coverage.length > 0 && openGoals.length === 0 && gaps.length === 0;

    if (!ready && !force) {
      const missing = [];
      if (coverage.length === 0) missing.push('no scope coverage recorded yet');
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

  /** Human-readable working position. This is the resume surface. */
  statusText({ decisions = 8 } = {}) {
    const lines = [];
    const goals = this.goalRows();
    const counts = { pending: 0, active: 0, completed: 0, blocked: 0 };
    for (const g of goals) counts[g.status] += 1;
    const active = this.activeGoalRow();

    lines.push(`objective: ${this.meta('objective') ?? '(none)'}`);
    lines.push(`scope: ${this.meta('scope_file') ?? 'SCOPE.md'} | status: ${this.meta('scope_status') ?? 'not initialized'}`);
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
