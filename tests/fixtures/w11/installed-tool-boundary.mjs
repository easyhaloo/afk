import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const [runtime, queryPath, cli, otherProject, originalPolicy, counterId] = process.argv.slice(2);
const load = path => import(pathToFileURL(join(runtime, path)).href);
const { createDefaultPluginRuntime } = await load('plugin-sdk/index.js');
const { prepareExperienceContext } = await load('application/learning/runtime.js');
const workspace = join(process.cwd(), 'managed-context');
await mkdir(workspace);
const query = JSON.parse(await readFile(queryPath, 'utf8'));
const owner = await createDefaultPluginRuntime();
const tool = 'tool.scan-manifest';
const contextFor = project => prepareExperienceContext({ plugins: owner, workItemId: `${project}#47`, worktreePath: workspace,
  prompt: query.prompt, applicability: query.applicability, target: { ...query.target, project } });
try {
  const selections = [];
  for (const [project, expected] of [[query.scope, tool], [otherProject, 'tool.returns']]) {
    const reference = await contextFor(project);
    const contents = await readFile(join(workspace, reference.path), 'utf8');
    const origins = [...contents.matchAll(/^Source: (.+)$/gm)].map(match => match[1]);
    assert.deepEqual(origins, [`${expected}@2.0.2`]);
    selections.push({ project, origins });
  }
  const second = await createDefaultPluginRuntime({ warn: () => {} });
  try {
    const readers = [owner, second].map(host => host.getVerificationProvider(tool));
    const input = '4006381333931';
    await assert.rejects(readers[0].verify({ input }), /authorization denied/);
    await assert.rejects(readers[0].verify({ input, target: otherProject }), /authorization denied/);
    const results = await Promise.all(readers.map((reader, index) => reader.verify({ target: query.scope,
      input: index ? `${input}\n4006381333932` : input })));
    assert.deepEqual(results.map(result => [result.passed, JSON.parse(result.output)]), [
      [true, { checked: 1, invalidLines: [] }], [false, { checked: 2, invalidLines: [2] }],
    ]);
    const policyPath = join(workspace, 'deny.json');
    const configure = async policy => {
      await writeFile(policyPath, JSON.stringify(policy));
      await promisify(execFile)(process.execPath, [cli, 'plugin', 'configure', 'policy.compliance-policy', '--builtin', '--file', policyPath]);
    };
    const counters = [owner, second].map(host => host.getVerificationProvider(counterId));
    const counts = await Promise.all(counters.map((reader, index) => reader.verify({ target: otherProject, input: index ? 'box lid' : 'box' })));
    assert.deepEqual(counts.map(result => result.output), ['1', '2']);
    await assert.rejects(counters[0].verify({ target: query.scope, input }), /authorization denied/);
    const policy = JSON.parse(await readFile(originalPolicy, 'utf8'));
    const grant = policy.sharedVerification.find(item => item.plugin === counterId);
    const dependency = join(process.cwd(), '.afk/plugins', counterId, dirname(grant.entry), 'words.mjs');
    const original = await readFile(dependency);
    await writeFile(dependency, 'export const count = () => 0;');
    try {
      for (const reader of counters) await assert.rejects(reader.verify({ target: otherProject, input }), /tree integrity mismatch/);
      const fresh = await createDefaultPluginRuntime({ warn: () => {} });
      try {
        assert.equal(fresh.getVerificationProvider(counterId), undefined);
        assert.ok((await fresh.diagnostics(counterId)).some(issue => /tree integrity mismatch/.test(issue.message)));
      } finally { await fresh.dispose(); }
    } finally { await writeFile(dependency, original); }
    assert.equal((await counters[0].verify({ target: otherProject, input: 'box lid' })).output, '2');
    policy.sharedVerification = policy.sharedVerification.filter(grant => grant.plugin !== counterId);
    await configure(policy);
    for (const reader of counters) await assert.rejects(reader.verify({ target: otherProject, input }), /authorization denied/);
    assert.equal((await readers[1].verify({ target: query.scope, input })).passed, true);
    await configure({ ...policy, rules: [{ id: 'revoke', effect: 'deny', actions: ['tool.source.read'] }] });
    for (const reader of readers) await assert.rejects(reader.verify({ target: query.scope, input }), /Tool source read denied/);
    assert.equal(await contextFor(otherProject), undefined);
    await assert.rejects(readFile(join(workspace, '.afk/experience-context.md')), { code: 'ENOENT' });
    console.log(JSON.stringify({ selections, concurrentResults: results.map(result => JSON.parse(result.output)), revokedReaders: readers.length,
      counterId, counts: counts.map(result => result.output), dependencyChangeDeniedReaders: counters.length, freshLoadDenied: true, revokedSharedReaders: counters.length }));
  } finally { await second.dispose(); }
} finally { await owner.dispose(); }
