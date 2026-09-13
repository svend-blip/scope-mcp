---
name: resume-work
description: Resume scope-driven project work from durable scope-mcp state after a fresh context, compaction, or restart - restore objective, current goal, and next action without re-supplying scope or history.
whenToUse: At the start of a session in a workspace that has SCOPE.md and scope-mcp state (.scope-mcp/state.db), after context compaction, or whenever asked to resume, continue, or pick up previous work.
---

# resume-work

Reconstruct the working position of a scope-mcp-managed project from the
workspace alone. Never ask the user to re-supply the scope or what was done:
SCOPE.md and the stored state answer both.

## Steps

1. **Read the contract.** Open `SCOPE.md` in the workspace.
2. **Read the stored position.** Call the MCP tool `mcp__scope-mcp__status`
   with `workspace: "<session working directory>"` (the path shown by `pwd`).
   Fallback when MCP tools are unavailable: run in the shell from the
   workspace `node --no-warnings <repo>/src/server.js --status --db .scope-mcp/state.db`.
3. **Confirm the current goal.** Call `mcp__scope-mcp__next_goal` with the
   same `workspace` (this also promotes the first pending goal when nothing
   is active).
4. **Reconstruct the position** from the status output: objective, current
   goal, the last checkpoint's `next_action`, open blockers, recent
   decisions, validation collected so far.
5. **Continue working.** Work the current goal, validate the work, call
   `mcp__scope-mcp__complete_goal` with the validation evidence, record
   decisions/blockers as they arise, and run save-checkpoint when pausing.
6. **Fresh project fallback.** If there is no stored state but SCOPE.md
   exists, treat it as a new project: call `mcp__scope-mcp__init_project`
   with the objective, then `mcp__scope-mcp__set_goals` with lightweight
   goals derived from the scope, and start with the first goal.

The SessionStart hook usually injects this same position automatically at
session start; this skill is the explicit, step-by-step path.
