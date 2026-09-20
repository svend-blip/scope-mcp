import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { nodeTooOld, MIN_NODE } from '../src/runtime-check.js';

// Found 2026-09-20 in a clean-machine rehearsal: with Node 18 on PATH the
// server died inside the ESM loader with ERR_UNKNOWN_BUILTIN_MODULE, and a
// launcher that reports the tail of stderr showed a stack frame. The person
// at the keyboard needs one sentence: which Node, which one is needed.

test('a Node without node:sqlite is named, with the version that is needed', () => {
  const message = nodeTooOld('18.19.1');
  assert.match(message, /Node\.js 18\.19\.1/);
  assert.match(message, new RegExp(`${MIN_NODE.major}\\.${MIN_NODE.minor}`));
  assert.match(message, /node:sqlite/);
  assert.ok(!message.includes('\n'), 'one line, so a launcher quoting the end of stderr shows all of it');
});

test('the boundary is 22.5', () => {
  assert.ok(nodeTooOld('22.4.9'));
  assert.equal(nodeTooOld('22.5.0'), null);
  assert.equal(nodeTooOld('22.22.3'), null);
  assert.equal(nodeTooOld('24.0.0'), null);
  assert.ok(nodeTooOld('20.18.0'));
});

test('a version it cannot read is not refused', () => {
  assert.equal(nodeTooOld('nightly'), null);
  assert.equal(nodeTooOld(undefined), null);
});

test('the server checks before it imports anything that needs node:sqlite', () => {
  const src = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
  const check = src.indexOf('nodeTooOld(');
  const state = src.indexOf("import('./state.js')");
  const doctor = src.indexOf("import('./doctor.js')");
  assert.ok(check > 0, 'server.js calls nodeTooOld');
  assert.ok(check < state && check < doctor, 'before state.js and doctor.js are imported');
});
