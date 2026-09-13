/**
 * MCP tool surface. Thin adapters: parse arguments, call ProjectState, render
 * text. All reasoning stays in the model.
 */
import { accessSync, constants, existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { ProjectState, defaultDbPath } from './state.js';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const goalShape = {
  id: z.string().describe('Short stable goal id, e.g. "g1".'),
  title: z.string().describe('One-line work unit title.'),
  description: z.string().optional().describe('Optional short detail.'),
  status: z.enum(['pending', 'active', 'completed', 'blocked']).optional().describe('Goal status.')
};

const coverageShape = {
  requirement: z.string().describe('Requirement taken from SCOPE.md.'),
  status: z.enum(['fulfilled', 'deferred', 'missing']).describe('How the repository satisfies it.'),
  note: z.string().optional().describe('Where/how it is satisfied or why deferred.')
};

/**
 * One MCP server process may serve several workspaces. When a call carries
 * `workspace`, the state file is `<workspace>/.scope-mcp/state.db`; otherwise
 * the server's own default (SCOPE_MCP_DB or `<cwd>/.scope-mcp/state.db`)
 * applies. Pass the session's working directory when the harness spawns the
 * server once per profile instead of once per workspace.
 */
const workspaceArg = z.string().optional().describe('Workspace root for this call; state is read/written from <workspace>/.scope-mcp/state.db. Defaults to the server workspace.');

function text(value) {
  return { content: [{ type: 'text', text: String(value) }] };
}

function goalLines(rows) {
  if (!rows.length) return '(no goals)';
  return rows.map((g) => `[${g.status}] ${g.id} - ${g.title}${g.validation ? ` (${g.validation})` : ''}`).join('\n');
}

/** The server's long-lived default store, set by registerTools. */
let defaultStore;

/**
 * Read-only environment diagnostic. Reports what is reasonably detectable
 * from inside the server process: platform, Node runtime, node:sqlite
 * capability, Harness home and profiles, skill roots and scope-mcp skill
 * discovery, hooks config presence, the effective state path and whether its
 * directory is writable, and any sandbox-policy overrides discoverable in
 * Harness profile patches. Never writes, never changes configuration.
 */
export function doctorReport({ dbPath, workspace } = {}) {
  const lines = [];
  const add = (key, value) => lines.push(`${key}: ${value}`);

  try {
    add('platform', `${process.platform} (${process.arch})`);
  } catch {
    add('platform', 'unknown');
  }
  add('node executable', process.execPath);
  add('node version', process.version);
  try {
    new DatabaseSync(':memory:').close();
    add('node:sqlite', 'available');
  } catch (error) {
    add('node:sqlite', `unavailable: ${String(error)}`);
  }

  const dshHome = process.env.DSH_HOME;
  add('harness home (DSH_HOME)', dshHome ?? 'not set (scope-mcp also works as a plain stdio MCP server)');

  const profiles = [];
  if (dshHome && existsSync(join(dshHome, 'profiles'))) {
    try {
      profiles.push(
        ...readdirSync(join(dshHome, 'profiles'), { withFileTypes: true })
          .filter((entry) => entry.isDirectory() && entry.name !== 'node_modules')
          .map((entry) => entry.name)
      );
    } catch {
      // diagnostics only
    }
  }
  add('harness profiles', profiles.length ? profiles.join(', ') : 'none discovered');

  const skillsRoot = dshHome ? join(dshHome, 'skills') : null;
  add('harness skills root', skillsRoot && existsSync(skillsRoot) ? skillsRoot : '(not found)');
  const repoSkills = join(REPO_ROOT, 'skills');
  add('repository skills root', existsSync(repoSkills) ? repoSkills : '(not found)');
  const discovered = [];
  if (skillsRoot && existsSync(skillsRoot)) {
    for (const name of ['resume-work', 'save-checkpoint']) {
      if (existsSync(join(skillsRoot, name, 'SKILL.md'))) discovered.push(name);
    }
  }
  add(
    'scope-mcp skill discovery',
    discovered.length
      ? `found in harness skills root: ${discovered.join(', ')}`
      : 'not installed in harness skills root (copy skills/resume-work and skills/save-checkpoint)'
  );

  add(
    'hooks config',
    existsSync(join(REPO_ROOT, 'scripts', 'hooks.json'))
      ? join(REPO_ROOT, 'scripts', 'hooks.json')
      : '(missing)'
  );
  add(
    'MCP registration',
    'this server is reachable over MCP (you are reading this output); client-side registration is not visible from inside the server'
  );

  const statePath = dbPath ?? defaultDbPath();
  add('effective project state path', statePath);
  add('SCOPE_MCP_DB', process.env.SCOPE_MCP_DB ?? '(unset)');
  const stateDir = dirname(statePath);
  if (!existsSync(stateDir)) {
    add('state directory', 'missing (created on first use)');
  } else {
    try {
      accessSync(stateDir, constants.W_OK);
      add('state directory writable', 'yes');
    } catch {
      add('state directory writable', 'no (automatic hooks would fail with "unable to open database file")');
    }
  }

  if (typeof workspace === 'string' && workspace.trim() !== '') {
    const workspacePath = join(workspace.trim(), '.scope-mcp', 'state.db');
    add('workspace state path', workspacePath);
    const workspaceDir = dirname(workspacePath);
    if (!existsSync(workspaceDir)) {
      add('workspace state directory', 'missing (created on first use)');
    } else {
      try {
        accessSync(workspaceDir, constants.W_OK);
        add('workspace state directory writable', 'yes');
      } catch {
        add('workspace state directory writable', 'no');
      }
    }
  }

  if (dshHome && profiles.length) {
    for (const name of profiles) {
      const patch = join(dshHome, 'profiles', name, 'cordis.patch.yml');
      if (!existsSync(patch)) continue;
      let text = '';
      try {
        text = readFileSync(patch, 'utf8');
      } catch {
        continue;
      }
      const block = /-\s+id:\s*sandbox-policy[\s\S]{0,500}?(?=\n-\s+id:|\n- insert:|$)/.exec(text)?.[0] ?? '';
      const mode = /mode:\s*['"]?([\w-]+)/.exec(block)?.[1];
      const root = /workspaceRoot:\s*(\S+)/.exec(block)?.[1];
      add(
        `profile ${name}: sandbox-policy`,
        mode ? `mode=${mode}${root ? `, workspaceRoot=${root}` : ''}` : 'no sandbox-policy override in patch'
      );
      add(
        `profile ${name}: hooks bridge`,
        /dsh-hooks-claude-code/.test(text) ? 'configured' : 'not configured'
      );
    }
  }

  return lines;
}

/**
 * Run one tool handler against the right store: a transient per-workspace
 * store when the call names a workspace, otherwise the server's long-lived
 * default store. Transient stores are closed after the call.
 */
function withStore(handler) {
  return (args = {}) => {
    const named = typeof args.workspace === 'string' && args.workspace.trim() !== '';
    const transient = named ? new ProjectState(join(args.workspace.trim(), '.scope-mcp', 'state.db')) : null;
    const store = transient ?? defaultStore;
    try {
      return handler(store, args);
    } finally {
      transient?.close();
    }
  };
}

export function registerTools(server, store) {
  defaultStore = store;

  server.registerTool(
    'init_project',
    {
      title: 'Initialize project from accepted scope',
      description:
        'Record the project objective and scope file. Idempotent: safe to call from a fresh context to refresh metadata and get back the current working position. Pass reset=true to clear tracked state and start over.',
      inputSchema: {
        objective: z.string().describe('One-paragraph project objective from the scope.'),
        scope_file: z.string().optional().describe('Path of the scope file, default SCOPE.md.'),
        reset: z.boolean().optional().describe('Clear goals/decisions/blockers/coverage/checkpoints first.'),
        workspace: workspaceArg
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
    },
    withStore((store, { objective, scope_file, reset }) =>
      text(store.init({ objective, scopeFile: scope_file ?? 'SCOPE.md', reset: Boolean(reset) }))
    )
  );

  server.registerTool(
    'status',
    {
      title: 'Inspect project status',
      description:
        'Human-readable working position: objective, scope status, current goal, completed/pending goals, validation state, coverage summary, open blockers, recent decisions, last checkpoint. Call this first when resuming after compaction or restart.',
      inputSchema: { workspace: workspaceArg }
    },
    withStore((store) => text(store.statusText()))
  );

  server.registerTool(
    'set_goals',
    {
      title: 'Establish or update generated goals',
      description:
        'Replace the lightweight goal list derived from SCOPE.md. Status of already-known goals is preserved; completed goals stay in the list even when omitted. Promotes the first pending goal when none is active.',
      inputSchema: {
        goals: z.array(z.object(goalShape)).describe('Full goal list, in intended order.'),
        workspace: workspaceArg
      }
    },
    withStore((store, { goals }) => text(goalLines(store.setGoals(goals))))
  );

  server.registerTool(
    'next_goal',
    {
      title: 'Get or select the current goal',
      description:
        'Returns the stored current goal, or promotes the first pending goal when none is active. With goal_id, makes that goal current. Pure lookup and promotion - planning stays with the model.',
      inputSchema: {
        goal_id: z.string().optional().describe('Optional id of the goal to make current.'),
        workspace: workspaceArg
      }
    },
    withStore((store, { goal_id }) => {
      const goal = store.nextGoal(goal_id);
      if (!goal) return text('no goal to work on; all listed goals are done - check coverage and complete_project');
      return text(`current goal: ${goal.id}: ${goal.title}`);
    })
  );

  server.registerTool(
    'complete_goal',
    {
      title: 'Mark a goal complete with validation',
      description:
        'Mark one goal completed together with the validation that proves it (test run, check performed, observed output). Automatically promotes the next pending goal. Validation is required.',
      inputSchema: {
        goal_id: z.string().describe('Goal id to complete.'),
        validation: z.string().describe('Evidence gathered, e.g. "npm test: 14 pass".'),
        notes: z.string().optional().describe('Optional short note, stored as a decision.'),
        workspace: workspaceArg
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
    },
    withStore((store, { goal_id, validation, notes }) => {
      const goal = store.completeGoal(goal_id, validation, notes);
      const next = store.activeGoalRow();
      return text(
        `completed: ${goal.id} - ${goal.title} (${goal.validation})\nnext goal: ${next ? `${next.id}: ${next.title}` : '(none - run coverage then complete_project)'}`
      );
    })
  );

  server.registerTool(
    'record_decision',
    {
      title: 'Record an important decision',
      description:
        'Store a short durable decision that later contexts must not re-litigate (accepted clarifications, chosen approach, deliberate deferrals). One or two sentences.',
      inputSchema: {
        text: z.string().describe('The decision, with enough reason to still make sense later.'),
        workspace: workspaceArg
      }
    },
    withStore((store, { text: body }) => text(`decision #${store.addDecision(body).seq} recorded`))
  );

  server.registerTool(
    'record_blocker',
    {
      title: 'Record or update a blocker',
      description:
        'Store an unresolved issue. When goal_id is given, that goal is also marked blocked. Open blockers keep a project from looking finished when it is not.',
      inputSchema: {
        text: z.string().describe('What is blocking progress and what would unblock it.'),
        goal_id: z.string().optional().describe('Optional goal this blocker stops.'),
        workspace: workspaceArg
      }
    },
    withStore((store, { text: body, goal_id }) => {
      if (goal_id) {
        store.blockGoal(goal_id, body);
        const blocker = store.openBlockers().at(-1);
        return text(`goal ${goal_id} blocked - blocker #${blocker.seq}: ${blocker.text}`);
      }
      const blocker = store.addBlocker(body);
      return text(`blocker #${blocker.seq}: ${blocker.text}`);
    })
  );

  server.registerTool(
    'resolve_blocker',
    {
      title: 'Resolve a blocker',
      description: 'Mark one open blocker resolved by its blocker number.',
      inputSchema: {
        seq: z.number().int().positive().describe('Blocker number shown by status.'),
        workspace: workspaceArg
      }
    },
    withStore((store, { seq }) => text(`blocker #${store.resolveBlocker(seq).seq} resolved`))
  );

  server.registerTool(
    'checkpoint',
    {
      title: 'Checkpoint work state before compaction',
      description:
        'Snapshot the working position so a fresh context can resume: current goal, work completed, important decisions, validation state, unresolved issues, next action. Omitted fields are filled from stored state. Call before context compaction or when ending a session.',
      inputSchema: {
        current_goal: z.string().optional(),
        work_completed: z.string().optional(),
        validation_state: z.string().optional(),
        unresolved_issues: z.string().optional(),
        next_action: z.string().optional().describe('What the next context should do first.'),
        workspace: workspaceArg
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
    },
    withStore((store, fields) => {
      const cp = store.checkpoint(fields);
      const lines = [`checkpoint at ${cp.at}`];
      for (const [key, value] of Object.entries(cp.payload)) lines.push(`  ${key}: ${value || '(unset)'}`);
      return text(lines.join('\n'));
    })
  );

  server.registerTool(
    'coverage',
    {
      title: 'Record scope coverage',
      description:
        'Map accepted SCOPE.md requirements against the repository before completion: fulfilled, deferred (with reason), or missing. Goal completion alone is not project completion.',
      inputSchema: {
        items: z.array(z.object(coverageShape)).describe('One entry per scope requirement.'),
        workspace: workspaceArg
      }
    },
    withStore((store, { items }) => {
      store.setCoverage(items);
      const c = store.coverageSummary();
      const missing = store.coverageRows().filter((r) => r.status === 'missing').map((r) => r.requirement);
      const summary = `${c.fulfilled} fulfilled, ${c.deferred} deferred, ${c.missing} missing`;
      return text(missing.length ? `${summary}\nunmet: ${missing.join(', ')}` : summary);
    })
  );

  server.registerTool(
    'doctor',
    {
      title: 'Diagnose the scope-mcp environment',
      description:
        'Read-only environment diagnostic: platform, Node runtime, node:sqlite capability, Harness home and profiles, skill roots and scope-mcp skill discovery, hooks config presence, the effective state path and writability, and any sandbox-policy configuration discoverable in Harness profile patches. Never changes anything.',
      inputSchema: { workspace: workspaceArg },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true }
    },
    withStore((_store, args) => text(doctorReport({ workspace: args.workspace }).join('\n')))
  );

  server.registerTool(
    'complete_project',
    {
      title: 'Check coverage and mark the project complete',
      description:
        'Guardrail completion check: all goals completed and every recorded coverage requirement fulfilled or deferred. Returns what is still missing otherwise. force=true completes anyway.',
      inputSchema: {
        force: z.boolean().optional().describe('Complete despite reported gaps.'),
        workspace: workspaceArg
      }
    },
    withStore((store, { force }) => {
      const report = store.completeProject({ force: Boolean(force) });
      const lines = [report.complete ? 'project complete' : 'not complete yet'];
      if (report.missing.length) lines.push(`missing: ${report.missing.join(' | ')}`);
      if (report.deferred.length) lines.push(`deferred: ${report.deferred.join(' | ')}`);
      if (report.blockers.length) lines.push(`open blockers: ${report.blockers.join(' | ')}`);
      lines.push(`validation: ${report.validation}`);
      return text(lines.join('\n'));
    })
  );
}
