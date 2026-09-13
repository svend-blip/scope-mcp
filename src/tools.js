/**
 * MCP tool surface. Thin adapters: parse arguments, call ProjectState, render
 * text. All reasoning stays in the model.
 */
import { z } from 'zod';

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

function text(value) {
  return { content: [{ type: 'text', text: String(value) }] };
}

function goalLines(rows) {
  if (!rows.length) return '(no goals)';
  return rows.map((g) => `[${g.status}] ${g.id} - ${g.title}${g.validation ? ` (${g.validation})` : ''}`).join('\n');
}

export function registerTools(server, store) {
  server.registerTool(
    'init_project',
    {
      title: 'Initialize project from accepted scope',
      description:
        'Record the project objective and scope file. Idempotent: safe to call from a fresh context to refresh metadata and get back the current working position. Pass reset=true to clear tracked state and start over (accepted scope documents are kept).',
      inputSchema: {
        objective: z.string().describe('One-paragraph project objective from the scope.'),
        scope_file: z.string().optional().describe('Path of the scope file, default SCOPE.md.'),
        reset: z.boolean().optional().describe('Clear goals/decisions/blockers/coverage/checkpoints first.')
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
    },
    ({ objective, scope_file, reset }) =>
      text(store.init({ objective, scopeFile: scope_file ?? 'SCOPE.md', reset: Boolean(reset) }))
  );

  server.registerTool(
    'status',
    {
      title: 'Inspect project status',
      description:
        'Human-readable working position: objective, effective scope summary, current goal, completed/pending goals, validation state, coverage summary, open blockers, recent decisions, accepted scope documents, last checkpoint. Call this first when resuming after compaction or restart, then get_effective_scope before reconciling goals.',
      inputSchema: {}
    },
    () => text(store.statusText())
  );

  server.registerTool(
    'record_scope',
    {
      title: 'Record the accepted base scope',
      description:
        'Persist the accepted base scope text as durable project intent, so a fresh context never needs it pasted again. A later base record supersedes earlier ones; recorded addenda stay available in order.',
      inputSchema: {
        text: z.string().describe('The accepted base scope.'),
        title: z.string().optional().describe('Optional short label for this scope record.')
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false }
    },
    ({ text: body, title }) => {
      const doc = store.recordScope({ text: body, title });
      return text(`base scope #${doc.seq} accepted ${doc.at}${title ? ` (${title})` : ''}`);
    }
  );

  server.registerTool(
    'add_scope_addendum',
    {
      title: 'Append an accepted scope addendum',
      description:
        'Append one accepted addendum after the current base scope, in recorded order. Effective scope is the base plus its active addenda in order; reconciling them is the model\'s job.',
      inputSchema: {
        text: z.string().describe('The accepted addendum.'),
        title: z.string().optional().describe('Optional short label for this addendum.')
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false }
    },
    ({ text: body, title }) => {
      const doc = store.addScopeAddendum({ text: body, title });
      return text(`addendum #${doc.seq} accepted ${doc.at}${title ? ` (${title})` : ''}`);
    }
  );

  server.registerTool(
    'get_effective_scope',
    {
      title: 'Read the effective scope',
      description:
        'Base scope plus its accepted addenda in order, with acceptance timestamps. Read this before reconciling goals and coverage after a cold start or fresh context.',
      inputSchema: {}
    },
    () => {
      const scope = store.effectiveScope();
      if (!scope) return text('(no scope documents recorded - the scope file on disk is the contract)');
      return text(`${scope.text}\n\n(${scope.addenda.length} addendum(s) after the base)`);
    }
  );

  server.registerTool(
    'set_goals',
    {
      title: 'Establish or update generated goals',
      description:
        'Replace the lightweight goal list derived from SCOPE.md. Status of already-known goals is preserved; completed goals stay in the list even when omitted. Promotes the first pending goal when none is active.',
      inputSchema: { goals: z.array(z.object(goalShape)).describe('Full goal list, in intended order.') }
    },
    ({ goals }) => text(goalLines(store.setGoals(goals)))
  );

  server.registerTool(
    'next_goal',
    {
      title: 'Get or select the current goal',
      description:
        'Returns the stored current goal, or promotes the first pending goal when none is active. With goal_id, makes that goal current. Pure lookup and promotion - planning stays with the model.',
      inputSchema: { goal_id: z.string().optional().describe('Optional id of the goal to make current.') }
    },
    ({ goal_id }) => {
      const goal = store.nextGoal(goal_id);
      if (!goal) return text('no goal to work on; all listed goals are done - check coverage and complete_project');
      return text(`current goal: ${goal.id}: ${goal.title}`);
    }
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
        notes: z.string().optional().describe('Optional short note, stored as a decision.')
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
    },
    ({ goal_id, validation, notes }) => {
      const goal = store.completeGoal(goal_id, validation, notes);
      const next = store.activeGoalRow();
      return text(
        `completed: ${goal.id} - ${goal.title} (${goal.validation})\nnext goal: ${next ? `${next.id}: ${next.title}` : '(none - run coverage then complete_project)'}`
      );
    }
  );

  server.registerTool(
    'record_decision',
    {
      title: 'Record an important decision',
      description:
        'Store a short durable decision that later contexts must not re-litigate (accepted clarifications, chosen approach, deliberate deferrals). One or two sentences.',
      inputSchema: { text: z.string().describe('The decision, with enough reason to still make sense later.') }
    },
    ({ text: body }) => text(`decision #${store.addDecision(body).seq} recorded`)
  );

  server.registerTool(
    'record_blocker',
    {
      title: 'Record or update a blocker',
      description:
        'Store an unresolved issue. When goal_id is given, that goal is also marked blocked. Open blockers keep a project from looking finished when it is not.',
      inputSchema: {
        text: z.string().describe('What is blocking progress and what would unblock it.'),
        goal_id: z.string().optional().describe('Optional goal this blocker stops.')
      }
    },
    ({ text: body, goal_id }) => {
      if (goal_id) {
        store.blockGoal(goal_id, body);
        const blocker = store.openBlockers().at(-1);
        return text(`goal ${goal_id} blocked - blocker #${blocker.seq}: ${blocker.text}`);
      }
      const blocker = store.addBlocker(body);
      return text(`blocker #${blocker.seq}: ${blocker.text}`);
    }
  );

  server.registerTool(
    'resolve_blocker',
    {
      title: 'Resolve a blocker',
      description: 'Mark one open blocker resolved by its blocker number.',
      inputSchema: { seq: z.number().int().positive().describe('Blocker number shown by status.') }
    },
    ({ seq }) => text(`blocker #${store.resolveBlocker(seq).seq} resolved`)
  );

  server.registerTool(
    'checkpoint',
    {
      title: 'Checkpoint work state before compaction',
      description:
        'Snapshot the working position so a fresh context can resume: current goal, work completed, important decisions, validation state, unresolved issues, next action. Omitted fields are filled from stored state. Harness hooks call this automatically at turn boundaries; call it directly only to add a more precise next_action.',
      inputSchema: {
        current_goal: z.string().optional(),
        work_completed: z.string().optional(),
        validation_state: z.string().optional(),
        unresolved_issues: z.string().optional(),
        next_action: z.string().optional().describe('What the next context should do first.')
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
    },
    (fields) => {
      const cp = store.checkpoint(fields);
      if (!cp) return text('nothing to checkpoint yet - no goals, decisions, blockers, or coverage recorded');
      const lines = [cp.unchanged ? `checkpoint unchanged at ${cp.at}` : `checkpoint at ${cp.at}`];
      for (const [key, value] of Object.entries(cp.payload)) lines.push(`  ${key}: ${value || '(unset)'}`);
      return text(lines.join('\n'));
    }
  );

  server.registerTool(
    'coverage',
    {
      title: 'Record scope coverage',
      description:
        'Map accepted SCOPE.md requirements against the repository before completion: fulfilled, deferred (with reason), or missing. Goal completion alone is not project completion.',
      inputSchema: { items: z.array(z.object(coverageShape)).describe('One entry per scope requirement.') }
    },
    ({ items }) => {
      store.setCoverage(items);
      const c = store.coverageSummary();
      const missing = store.coverageRows().filter((r) => r.status === 'missing').map((r) => r.requirement);
      const summary = `${c.fulfilled} fulfilled, ${c.deferred} deferred, ${c.missing} missing`;
      return text(missing.length ? `${summary}\nunmet: ${missing.join(', ')}` : summary);
    }
  );

  server.registerTool(
    'complete_project',
    {
      title: 'Check coverage and mark the project complete',
      description:
        'Guardrail completion check: all goals completed and every recorded coverage requirement fulfilled or deferred. Returns what is still missing otherwise. force=true completes anyway.',
      inputSchema: { force: z.boolean().optional().describe('Complete despite reported gaps.') }
    },
    ({ force }) => {
      const report = store.completeProject({ force: Boolean(force) });
      const lines = [report.complete ? 'project complete' : 'not complete yet'];
      if (report.missing.length) lines.push(`missing: ${report.missing.join(' | ')}`);
      if (report.deferred.length) lines.push(`deferred: ${report.deferred.join(' | ')}`);
      if (report.blockers.length) lines.push(`open blockers: ${report.blockers.join(' | ')}`);
      lines.push(`validation: ${report.validation}`);
      return text(lines.join('\n'));
    }
  );
}
