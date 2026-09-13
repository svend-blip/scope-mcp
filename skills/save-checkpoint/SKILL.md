---
name: save-checkpoint
description: Persist the current project's working position into scope-mcp so any later context can continue. Use when the user says "save checkpoint", "checkpoint this work", "park this work", "save state", "pause and save", or before a long operation that may be interrupted.
whenToUse: End of a work session, before compaction, before switching tasks, or whenever the working position must survive a context reset.
---

# Save Checkpoint

Persist the working position of the current workspace through the `scope-mcp` MCP tools. Scope, goals, validation, blockers and the next action go into durable state; conversation history does not.

State lives per workspace in `<workspace>/.scope-mcp/state.db` (or `$SCOPE_MCP_DB`). Never write one shared database: each project keeps its own.

## Procedure

Follow the steps in order. Do not ask the user to repeat anything already in durable state.

1. Work in the current DeepSeek Harness workspace. Do not change directory and do not assume any particular install path for scope-mcp itself.

2. Call `status`. That gives objective, effective-scope summary, goal counts, current goal, validation, coverage, blockers, decisions and the last checkpoint.

3. If the project is not initialized: look for `SCOPE.md`, then `AGENTS.md` or `README.md` in the workspace. Call `init_project` with an objective taken from that text. If a scope file exists but no scope documents are recorded yet, call `record_scope` with its accepted text. If no scope or durable intent can be read from the workspace, report that limitation and stop — do not invent project scope.

   Intake works the same way at any point: text the user presents as the project scope becomes the base scope through `record_scope` when none is recorded yet; text presented as an addition or modification to the existing scope goes in with `add_scope_addendum`, in the order it was accepted. Nothing else has to classify text.

4. Determine what to record, from state plus what just happened in this session:
   - current goal: from `status`, or `next_goal`
   - work completed since the last checkpoint: finished goals, edits that are already on disk
   - validation state: what actually ran and passed (test command and counts)
   - unresolved issues: anything still failing, waiting on external access, or half-done
   - important decisions: choices a later context must not re-litigate
   - exact next action: the first concrete thing the next context should do

5. Call `checkpoint`. Pass only what adds precision beyond stored state — usually `next_action`, sometimes `unresolved_issues` and `validation_state`. Omitted fields are derived automatically. Keep every field a short summary, never a transcript or pasted source code.

6. Record supporting detail as its own state, not inside the checkpoint text: `complete_goal` with validation evidence for finished goals, `record_decision` for durable choices, `record_blocker` for real blockers, `resolve_blocker` when one is cleared.

7. Verify persistence: call `status` again and confirm the last checkpoint timestamp moved and the next action reads correctly. If it did not change and nothing about the position changed, that is correct behaviour — unchanged snapshots are not duplicated.

8. Stop. Report in one short block: current goal, validation recorded, next action. Continue working only if the user asked for that in the same request.

## Boundaries

* Project intent and execution state are separate. Scope documents stay in the scope documents (`record_scope`, `add_scope_addendum`); checkpoints hold only the working position — goal, progress, validation, issues, decisions, next action. Do not paste scope or addendum text into checkpoint fields.
* The repository remains the source of truth for implementation. Do not copy code into state.
* Coverage and completion are separate calls: use `coverage` and `complete_project` only when the scope is actually satisfied.
* Hooks already checkpoint automatically at turn boundaries. This skill is for an explicit, higher-quality save on request; it uses the same stored fields, so running both is harmless.
