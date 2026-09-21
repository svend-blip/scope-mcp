import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ProjectState, defaultDbPath } from '../src/state.js';

const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function read(relative) {
  return readFileSync(new URL(`../${relative}`, import.meta.url), 'utf8');
}

/** Harness parses YAML frontmatter; only the two required scalars are checked here. */
function frontmatter(markdown) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(markdown);
  assert.ok(match, 'skill file must open with YAML frontmatter');
  const fields = {};
  for (const line of match[1].split(/\r?\n/)) {
    const pair = /^([A-Za-z]+):\s*(.*)$/.exec(line.trim());
    if (pair) fields[pair[1]] = pair[2];
  }
  return { fields, body: markdown.slice(match[0].length) };
}

test('both global skills exist in the repository and use the native Harness name format', () => {
  for (const dir of ['save-checkpoint', 'resume-work']) {
    const { fields, body } = frontmatter(read(`skills/${dir}/SKILL.md`));
    assert.match(fields.name, SKILL_NAME, `${dir}: Harness requires lowercase-hyphen skill names`);
    assert.ok((fields.description ?? '').length > 20, `${dir}: description must explain when to use it`);
    assert.ok(body.trim().length > 200, `${dir}: body must carry the procedure`);
  }
});

test('skills drive scope-mcp state without assuming any install path', () => {
  const save = read('skills/save-checkpoint/SKILL.md');
  const resume = read('skills/resume-work/SKILL.md');

  for (const [name, text] of [['save-checkpoint', save], ['resume-work', resume]]) {
    assert.ok(!text.includes('/home/svend'), `${name}: must not hard-code one machine path`);
    assert.match(text, /\.scope-mcp\/state\.db/, `${name}: state stays project-local`);
    assert.match(text, /\$SCOPE_MCP_DB/, `${name}: honours the override variable`);
    assert.match(text, /`status`/, `${name}: reads the resume surface`);
    assert.match(text, /`checkpoint`/, `${name}: writes durable working state`);
  }

  assert.match(save, /`record_scope`|record_scope/, 'save-checkpoint keeps durable intent current');
  assert.match(save, /report that limitation/, 'save-checkpoint must not invent scope');
  assert.match(resume, /`get_effective_scope`/, 'resume-work must load persisted intent with its addenda');
  assert.match(resume, /[Rr]econcile/, 'resume-work reconciles state against the repository');
  assert.match(resume, /`complete_goal`/, 'resume-work continues goal by goal');
});

test('each workspace resolves its own state file', () => {
  const saved = process.env.SCOPE_MCP_DB;
  delete process.env.SCOPE_MCP_DB;
  try {
    // join(): the separator is the platform's. The literal '/work/alpha/...'
    // made this a Linux-only statement about a function that is right on both.
    assert.equal(defaultDbPath('/work/alpha'), join('/work/alpha', '.scope-mcp', 'state.db'));
    assert.equal(defaultDbPath('/work/beta'), join('/work/beta', '.scope-mcp', 'state.db'));
    assert.notEqual(defaultDbPath('/work/alpha'), defaultDbPath('/work/beta'));
    assert.match(defaultDbPath(), /\.scope-mcp[\\/]state\.db$/, 'no override still means a per-workspace file');
  } finally {
    if (saved !== void 0) process.env.SCOPE_MCP_DB = saved;
  }
});

test('two workspaces keep separate project state', () => {
  const first = new ProjectState(':memory:');
  first.init({ objective: 'alpha project' });
  first.setGoals([{ id: 'g1', title: 'alpha step' }]);
  assert.equal(first.goalRows().length, 1);

  const second = new ProjectState(':memory:');
  assert.equal(second.meta('objective'), null, 'a fresh workspace starts empty');
  second.init({ objective: 'beta project' });
  assert.equal(second.goalRows().length, 0);
  assert.equal(first.meta('objective'), 'alpha project', 'the first workspace keeps its own record');
  first.close();
  second.close();
});

test('the package ships the server, hooks, skills and documentation together', () => {
  const pkg = JSON.parse(read('package.json'));
  for (const entry of ['src', 'hooks.json', 'skills', 'README.md', 'SCOPE.md']) {
    assert.ok(pkg.files.includes(entry), `files must include ${entry}`);
  }
  assert.equal(pkg.dependencies['@modelcontextprotocol/sdk'].startsWith('^'), true);
});

test('hook config and README stay consistent for an installing agent', () => {
  const config = JSON.parse(read('hooks.json'));
  assert.deepEqual(Object.keys(config.hooks).sort(), ['SessionStart', 'Stop', 'UserPromptSubmit']);

  const readme = read('README.md');
  assert.match(readme, /^## AI-assisted installation$/m, 'short path for a human to hand over');
  assert.match(readme, /^## AI Installation Instruction$/m, 'full procedure for the installing agent');
  assert.match(readme, /^## Normal usage$/m, 'daily workflow after installation');
  assert.match(readme, /\$DSH_HOME/, 'profiles are located through the harness home variable');
  assert.match(readme, /node:sqlite/, 'the runtime requirement is stated');
  assert.match(readme, /save-checkpoint/, 'both global skills are documented');
  assert.match(readme, /resume-work/);
  assert.match(readme, /backup/i, 'existing harness configuration must be preserved');

  for (const groups of Object.values(config.hooks)) {
    for (const group of groups) {
      for (const hook of group.hooks) {
        assert.match(
          hook.command,
          /\$\{CLAUDE_PLUGIN_ROOT\}\/src\/server\.js"? hook (stop|session-start|prompt-submit)/,
          'commands resolve through the installed package root, not one machine path'
        );
      }
    }
  }
});
