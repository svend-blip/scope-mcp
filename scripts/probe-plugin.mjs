/**
 * HISTORICAL diagnostic probe plugin for the scope-mcp harness installation.
 * Logs plugin activation and root-scope event delivery to a fixed path.
 * Machine-specific fixture from the Windows validation run: the absolute log
 * path below belongs to that environment only. Do not install this plugin in
 * production profiles; it was removed from the active profile after validation.
 */
import { appendFileSync } from 'node:fs';

const LOG = 'C:/Users/svend/scope-mcp/.scope-mcp/probe.log';

function log(line) {
  try {
    appendFileSync(LOG, `${new Date().toISOString()} | ${line}\n`);
  } catch {
    // diagnostics only
  }
}

export const name = 'scope-mcp-probe';

export function apply(ctx) {
  log('apply: plugin instantiated');
  ctx.on('tools/post-execute', () => {
    log('event: tools/post-execute reached root listener');
  });
  ctx.on('agent/turn-stopping', () => {
    log('event: agent/turn-stopping reached root listener');
  });
  ctx.on('agent/session-start', () => {
    log('event: agent/session-start reached root listener');
  });
}
