---
name: save-checkpoint
description: Persist the current scope-mcp working position - current goal, completed work with validation, open blockers, next action - so a later context can resume exactly here.
whenToUse: Before ending or pausing a work session on a scope-mcp-managed project, before context compaction, before starting long work you might not finish in this context, or whenever the user asks to checkpoint or save progress.
---

# save-checkpoint

Save a durable working position into the workspace's scope-mcp state so a fresh
context (new session, compaction, restart) can resume without re-supplying
history.

## Steps

1. **Determine the workspace.** Use the session working directory (the path
   shown by `pwd` in the shell tool).
2. **Summarize the position briefly.** Active goal, what is done with its
   validation, open blockers, and the single next action. One or two lines per
   field; no transcripts.
3. **Save it.**
   - Preferred: call the MCP tool `mcp__scope-mcp__checkpoint` with
     `workspace: "<session working directory>"` and a short `next_action`.
     Omit the other fields - they are derived from stored state.
   - MCP tools unavailable: run in the shell from the workspace
     `node --no-warnings <repo>/src/server.js --checkpoint "<next action>" --db .scope-mcp/state.db`
     (on Windows, `--db .scope-mcp/state.db` resolves against the workspace).
4. **Verify.** Call `mcp__scope-mcp__status` (or the CLI `--status`) and check
   that `current_goal` and the checkpoint's `next_action` are correct.
5. **Report** the checkpoint to the user in one line, then it is safe to end
   the session or compact.

Note: the harness runs a Stop hook that snapshots automatically when a run
ends, and it skips unchanged positions. Use this skill when you want to pin
the position explicitly or when the automatic snapshot may not run.
