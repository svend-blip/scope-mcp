---
name: resume-work
description: Reconstruct durable project state from scope-mcp and continue the project autonomously. Use when the user says "resume work", "continue project", "continue from checkpoint", "pick up where we left off", "restore project state", or when a fresh session needs to find its footing again.
whenToUse: A fresh Harness session, a restarted machine, a compacted context, or any point where the working position must be rebuilt without re-explaining it.
---

# Resume Work

Rebuild the working position from durable state and continue. The user should not have to re-supply anything.

## Procedure

Follow the steps in order.

1. Work in the current DeepSeek Harness workspace. State is workspace-local: `<workspace>/.scope-mcp/state.db` (or `$SCOPE_MCP_DB`). Do not reuse another project's state file.

2. Call `status`. Read, in this order: objective, effective-scope line, goal counts, current goal, validation, coverage, blockers, decisions, last checkpoint and its next action.

3. Call `get_effective_scope` when scope documents exist. The effective scope is the accepted base plus its accepted addenda in recorded order; later entries refine earlier ones. If nothing is recorded, read `SCOPE.md` from the workspace instead.

4. From that state take: current goal, completed goals with their validation evidence, pending goals, validation status, open blockers, recent decisions, latest checkpoint, recorded next action.

5. Inspect the actual repository before trusting any of it: read the files the completed goals point at, run the project's own check (`npm test` or equivalent) when it is cheap.

6. Reconcile durable state with repository reality:
   - work that exists on disk but is unrecorded → `complete_goal` with the observed evidence
   - recorded completion the repository does not show → say so, then reopen or continue the goal
   - goal list stale against the effective scope → `set_goals`, keeping completed goals and adding or adjusting only what the effective scope requires
   - blocker no longer real → `resolve_blocker`

   The repository is authoritative for implementation reality; scope-mcp is authoritative for durable working state and persisted intent. Resolve the discrepancy instead of picking whichever is convenient.

7. Determine the resume point: the recorded next action when present, otherwise the current active goal (`next_goal`). Completed work is not repeated.

8. Continue autonomously from there: work → validate → `complete_goal` with evidence → `record_decision` / `record_blocker` as they occur → next goal. Checkpoint at natural boundaries with `checkpoint`.

9. Finish by checking the scope, not just the goal list: `coverage` per requirement, then `complete_project`. Report what is fulfilled, deferred, missing, and any open blocker.

Stop when the effective scope is complete, when a genuine blocker needs the user, or when the user asks to stop. Hooks may inject the same position automatically; that injection is the same data, so continue from it without re-reading everything twice.

## Boundaries

* Do not ask the user to restate scope, goals, checkpoints, or implementation history.
* Do not restart completed work to "get oriented"; read the state, verify against files, continue.
* Keep injected and stored text compact: summaries and evidence, not transcripts.
