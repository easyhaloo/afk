import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { extractContract, findSkill, listSkillMetadata, recommendSkill, skillRoots } from '../scripts/skill-catalog.mjs';

test('catalog reads bounded Skill metadata and mandatory step titles', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jev skill catalog '));
  try {
    const skill = path.join(directory, 'debug');
    fs.mkdirSync(skill);
    fs.writeFileSync(path.join(skill, 'SKILL.md'), [
      '---', 'name: systematic-debugging', 'description: Diagnose failing tests before proposing a fix.', '---',
      '# Debug', '## Steps', '1. Reproduce the failing test', '2. Inspect the first failure',
      '## Caveats', '- MUST NOT print credentials',
    ].join('\n'));
    const catalog = listSkillMetadata([directory]);
    assert.equal(catalog.length, 1);
    assert.equal(catalog[0].name, 'systematic-debugging');
    assert.equal(findSkill(catalog, 'systematic-debugging').name, 'systematic-debugging');
    const contract = extractContract(fs.readFileSync(catalog[0].file, 'utf8'));
    assert.deepEqual(contract.steps, ['Reproduce the failing test', 'Inspect the first failure']);
    assert.equal(contract.constraints.length, 1);
    assert.doesNotMatch(JSON.stringify(catalog), /MUST NOT print credentials/);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('catalog retains invocation restrictions and source paths for manual lookup', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jev restricted skill '));
  try {
    const root = path.join(directory, 'skills');
    const target = path.join(directory, 'manual-review');
    fs.mkdirSync(root);
    fs.mkdirSync(target);
    const file = path.join(target, 'SKILL.md');
    fs.writeFileSync(file, [
      '---', 'name: manual-review', 'description: Review changes.',
      'disable-model-invocation: true # manual invocation only',
      'user-invocable: true', 'allowed-tools: Read, Grep', 'disallowed-tools: >-',
      '  Write(*)', '  Edit(*)', '---', '## Steps', '1. Review changes',
    ].join('\n'));
    fs.symlinkSync(target, path.join(root, 'manual-review'), 'dir');
    const catalog = listSkillMetadata([root]);
    const skill = findSkill(catalog, 'manual-review');
    assert.ok(skill);
    assert.equal(skill['disable-model-invocation'], true);
    assert.equal(skill['user-invocable'], true);
    assert.equal(skill['allowed-tools'], 'Read, Grep');
    assert.equal(skill['disallowed-tools'], 'Write(*) Edit(*)');
    assert.deepEqual(skill.source, { root: path.resolve(root), file: fs.realpathSync(file) });
    assert.deepEqual(extractContract(fs.readFileSync(skill.file, 'utf8')).steps, ['Review changes']);
    assert.equal(await recommendSkill('Review changes', catalog, async () => {
      assert.fail('A disabled Skill must not reach remote selection');
    }), null);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

for (const fieldName of ['allowed-tools', 'disallowed-tools']) {
  for (const [format, suffix, lines, expected] of [
    ['unindented lists', '', ['- Read', '# Between tools', '- Grep'], ['Read', 'Grep']],
    ['commented list headers', ' # permitted tools', ['  - Read'], ['Read']],
    ['commented list items', '', [
      '  - "Write(*)" # no writes', "  - 'Read # literal' # explanation", '  - Grep # search',
    ], ['Write(*)', 'Read # literal', 'Grep']],
  ]) {
    test(`catalog preserves ${format} for ${fieldName}`, () => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jev tool syntax '));
      try {
        const skill = path.join(directory, 'tool-syntax');
        fs.mkdirSync(skill);
        fs.writeFileSync(path.join(skill, 'SKILL.md'), [
          '---', 'name: tool-syntax', 'description: Review changes.', `${fieldName}:${suffix}`,
          ...lines, 'user-invocable: false', 'metadata:', '  unrelated:', '    - Edit(*)', '---',
        ].join('\n'));
        const entry = findSkill(listSkillMetadata([directory]), 'tool-syntax');
        assert.deepEqual(entry[fieldName], expected);
        assert.equal(entry['user-invocable'], false);
      } finally { fs.rmSync(directory, { recursive: true, force: true }); }
    });
  }

  test(`catalog preserves indented YAML lists for ${fieldName}`, () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jev tool list '));
    try {
      const skill = path.join(directory, 'tool-list');
      fs.mkdirSync(skill);
      fs.writeFileSync(path.join(skill, 'SKILL.md'), [
        '---', 'name: tool-list', 'description: Review changes.', `${fieldName}:`,
        '  - Read', '  - "Grep"', "  - 'Bash(npx langfuse-cli api * list *)'",
        '', '  # Keep tool expressions intact.', '  - WebFetch(domain:langfuse.com)',
        'user-invocable: false', 'metadata:', '  unrelated:', '    - Write(*)', '---',
      ].join('\r\n'));
      const entry = findSkill(listSkillMetadata([directory]), 'tool-list');
      assert.deepEqual(entry[fieldName], [
        'Read', 'Grep', 'Bash(npx langfuse-cli api * list *)', 'WebFetch(domain:langfuse.com)',
      ]);
      assert.equal(entry['user-invocable'], false);
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });
}

test('a disabled Skill in the first root shadows an automatic Skill with the same name', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jev skill precedence '));
  try {
    const roots = ['project', 'user'].map(name => path.join(directory, name));
    for (const [index, root] of roots.entries()) {
      const skill = path.join(root, 'review');
      fs.mkdirSync(skill, { recursive: true });
      fs.writeFileSync(path.join(skill, 'SKILL.md'), [
        '---', 'name: review', 'description: Review changes.',
        `disable-model-invocation: ${index === 0}`, '---',
      ].join('\n'));
    }
    const catalog = listSkillMetadata(roots);
    assert.equal(catalog.length, 1);
    assert.equal(findSkill(catalog, 'review').file, path.join(roots[0], 'review', 'SKILL.md'));
    assert.equal(await recommendSkill('Review changes', catalog), null);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('invocation defaults preserve automatic and hidden Skills', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jev skill defaults '));
  try {
    const definitions = [
      ['default-review', []],
      ['hidden-review', ['disable-model-invocation: false', 'user-invocable: false']],
    ];
    for (const [name, metadata] of definitions) {
      const skill = path.join(directory, name);
      fs.mkdirSync(skill);
      fs.writeFileSync(path.join(skill, 'SKILL.md'), [
        '---', `name: ${name}`, 'description: Review changes.', ...metadata, '---',
      ].join('\n'));
    }
    const catalog = listSkillMetadata([directory]);
    const defaultSkill = findSkill(catalog, 'default-review');
    assert.equal(defaultSkill['disable-model-invocation'], false);
    assert.equal(defaultSkill['user-invocable'], true);
    const hiddenSkill = findSkill(catalog, 'hidden-review');
    assert.equal(hiddenSkill['disable-model-invocation'], false);
    assert.equal(hiddenSkill['user-invocable'], false);
    assert.equal(await recommendSkill('Review changes', [hiddenSkill]), 'hidden-review');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('automatic ranking excludes disabled Skills before remote selection and fallback', async () => {
  const catalog = [
    { name: 'manual-review', description: 'Review changes.', 'disable-model-invocation': true },
    { name: 'review-code', description: 'Review code changes.' },
    { name: 'review-security', description: 'Review security changes.' },
  ];
  let calls = 0;
  let candidates;
  const result = await recommendSkill('Review changes', catalog, async state => {
    calls += 1;
    candidates = state.candidates;
    return 'manual-review';
  });
  assert.equal(calls, 1);
  assert.deepEqual(candidates, [{ name: 'review-code' }, { name: 'review-security' }]);
  assert.equal(result, 'review-code');
  assert.equal(await recommendSkill('Review changes', catalog, async () => {
    throw new Error('offline');
  }), 'review-code');
});

test('Playbook numbered steps are included in the Skill contract', () => {
  const contract = extractContract([
    '---', 'name: build', 'description: Build and deploy.', '---',
    '## Playbook', '### Build request', '1. Check git status', '2. Run the build',
    '## Error handling', '1. This is not a Playbook step',
  ].join('\n'));
  assert.deepEqual(contract.steps, ['Check git status', 'Run the build']);
});

test('single relevant Skill is recommended without a Jev request', async () => {
  const catalog = [{ name: 'systematic-debugging', description: 'Diagnose failing tests before a fix.' }];
  const choice = await recommendSkill('Diagnose this failing test', catalog,
    async () => { throw new Error('Jev should not be called'); });
  assert.equal(choice, 'systematic-debugging');
});

test('ambiguous Skill selection delegates a bounded term set to Jev', async () => {
  const catalog = [
    { name: 'review-code', description: 'Review code changes' },
    { name: 'review-security', description: 'Review security changes' },
  ];
  const result = await recommendSkill('Review changes password=super-secret', catalog, async state => {
    assert.doesNotMatch(JSON.stringify(state), /super-secret|password=/);
    return 'review-security';
  });
  assert.equal(result, 'review-security');
});

test('extracted contract strips obvious credential values before remote evaluation', () => {
  const contract = extractContract('---\nname: debug\ndescription: debug\n---\n## Steps\n1. Check token=super-secret\n- MUST NOT reveal password=hunter2\n');
  assert.doesNotMatch(JSON.stringify(contract), /super-secret|hunter2/);
});

test('Skill roots remain absolute when HOME is unavailable', () => {
  const roots = skillRoots('codex', '/project', { USERPROFILE: '/users/example' });
  assert.ok(roots.every(root => path.isAbsolute(root)));
});
