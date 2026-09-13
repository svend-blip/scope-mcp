import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Installation hardening: production logic must never depend on
 * developer-specific absolute paths. Machine-specific fixture files
 * (scripts/hooks.json, scripts/probe-plugin.mjs) are excluded here but must
 * carry a visible marker naming them historical examples.
 */
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const PRODUCTION_FILES = [
  'src/state.js',
  'src/tools.js',
  'src/server.js',
  'scripts/scope-hooks.js',
  'scripts/demo.js',
  'skills/resume-work/SKILL.md',
  'skills/save-checkpoint/SKILL.md',
  'package.json'
];

const FORBIDDEN = [
  { label: '/home/svend', pattern: /\/home\/svend/ },
  { label: 'C:\\Users\\svend', pattern: /C:\\Users\\svend/i },
  { label: '/usr/bin/node', pattern: /\/usr\/bin\/node/ },
  { label: 'C:\\Program Files\\nodejs', pattern: /C:\\Program Files\\nodejs/i }
];

test('production files carry no developer-specific absolute paths', () => {
  for (const rel of PRODUCTION_FILES) {
    const text = readFileSync(join(ROOT, rel), 'utf8');
    for (const { label, pattern } of FORBIDDEN) {
      assert.doesNotMatch(text, pattern, `${rel} must not contain ${label}`);
    }
  }
});

test('machine-specific hook/probe fixtures are clearly marked as historical examples', () => {
  const hooks = readFileSync(join(ROOT, 'scripts', 'hooks.json'), 'utf8');
  assert.match(hooks, /_comment/, 'hooks.json must carry a marker key');
  assert.match(hooks, /Historical fixture|machine-specific|EXAMPLE/i, 'the marker must name it a machine-specific example');
  const probe = readFileSync(join(ROOT, 'scripts', 'probe-plugin.mjs'), 'utf8');
  assert.match(probe, /HISTORICAL/i, 'the probe plugin must be marked as a historical diagnostic fixture');
});
