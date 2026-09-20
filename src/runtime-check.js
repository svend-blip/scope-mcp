/**
 * The one runtime requirement, checked before anything that has it is
 * imported: node:sqlite arrived in Node 22.5. Without the check an older Node
 * dies inside the module loader with ERR_UNKNOWN_BUILTIN_MODULE, and whoever
 * started the server sees a stack frame instead of a reason.
 *
 * This file must run on any Node that can parse ES modules: no imports.
 */
export const MIN_NODE = { major: 22, minor: 5 };

/** One-line refusal for a Node that is too old, or null when it will do. */
export function nodeTooOld(version) {
  const match = /^v?(\d+)\.(\d+)/.exec(String(version ?? ''));
  if (!match) return null; // unreadable: let the import decide
  const [major, minor] = [Number(match[1]), Number(match[2])];
  if (major > MIN_NODE.major || (major === MIN_NODE.major && minor >= MIN_NODE.minor)) return null;
  const found = String(version).replace(/^v/, '');
  return `scope-mcp needs Node.js ${MIN_NODE.major}.${MIN_NODE.minor} or newer (for the built-in node:sqlite); ` +
    `this is Node.js ${found} at ${process.execPath} - install a newer Node.js and make sure it is ` +
    'the first "node" on PATH';
}
