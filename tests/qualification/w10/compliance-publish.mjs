import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, realpath, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { arch, platform, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { prepareRepositoryRun, startRepositoryServer } from '../../e2e/repository-managed-local.fixture.ts';

process.umask(0o077);
assert.equal(process.argv.length, 3, 'Usage: node compliance-publish.mjs INSTALLED_AFK');
const entry = await realpath(process.argv[2]);
const release = dirname(dirname(entry));
assert.equal(entry, join(release, 'dist/index.js'));
const { version } = JSON.parse(await readFile(join(release, 'release.json'), 'utf8'));
const yaml = createRequire(join(release, 'node_modules/@afk/runtime/package.json'))('js-yaml');

async function qualify(action, expectDenied) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'afk-policy-publish-')));
  const pushes = [];
  const server = await startRepositoryServer(root, request => pushes.push(request));
  try {
    const { cli, git, manifest, repositories, workItemId } = await prepareRepositoryRun(root, server.host, entry, false, undefined, 'compliance-policy');
    assert.equal((await cli('--version')).trim(), version);
    const config = join(root, '.afk/plugins.yml');
    const settings = yaml.load(await readFile(config, 'utf8'));
    const context = { project: workItemId.split('#')[0] };
    const input = { action, context };
    settings.integrations.policies[0].input = input;
    await writeFile(config, JSON.stringify(settings));
    const paths = {};
    for (const effect of ['allow', 'deny']) {
      paths[effect] = join(root, `${effect}.json`);
      await writeFile(paths[effect], JSON.stringify({ rules: [{ id: effect, effect, actions: [action],
        when: context }] }));
    }
    const configure = ['plugin', 'configure', 'policy.compliance-policy', '--builtin', '--file'];
    await cli(...configure, paths.allow);
    const fixtureAgent = join(root, 'bin', 'claude');
    const agent = await readFile(fixtureAgent, 'utf8');
    assert.equal(agent.split('\ndone\necho ').length, 2);
    await writeFile(join(root, 'rotate.mjs'), `import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
execFileSync(process.execPath, ${JSON.stringify([entry, ...configure, paths.deny])}, { cwd: ${JSON.stringify(root)} });
writeFileSync('policy-rotated', 'denied', { flag: 'wx' });
`);
    const quote = text => `'${text.replaceAll("'", "'\\''")}'`;
    await writeFile(fixtureAgent, agent.replace('\ndone\necho ', `\ndone\n(cd "$HOME"; ${quote(process.execPath)} rotate.mjs)\necho `));
    pushes.length = 0;
    server.requests.length = 0;
    let exit = 0;
    try {
      await cli('run', '--template', 'issue-implementation', '--agent', 'claude-code', '--execution-mode', 'batch',
        '--backlog-id', workItemId, '--execution-manifest', manifest, '--hard-timeout', '35000');
    } catch (error) {
      if (!expectDenied || !error.stderr?.includes('Execution denied by capability policy')) throw error;
      exit = error.code;
    }
    assert.equal(exit, expectDenied ? 1 : 0);
    assert.equal(await readFile(join(root, 'policy-rotated'), 'utf8'), 'denied');
    const auditRuns = JSON.parse(await cli('observe', 'runs', '--json'));
    assert.equal(auditRuns.length, 1);
    const audit = JSON.parse(await cli('observe', auditRuns[0], '--json'));
    assert.equal(audit.integrity.valid, true);
    const status = audit.state.run.status;
    assert.equal(status, expectDenied ? 'failed' : 'awaiting_human');
    const events = audit.events.map(({ data }) => data);
    const completed = events.filter(event => event.kind === 'step.completed' && event.outcome === 'succeeded').map(event => event.stepId);
    assert.deepEqual(completed, ['implement', 'verify-ac']);
    assert.equal(events.some(event => event.kind === 'change.published'), !expectDenied);
    const failure = events.find(event => event.kind === 'run.finished' && event.outcome === 'failed');
    assert.equal(failure?.reason, expectDenied ? 'Execution denied by capability policy' : undefined);
    const mrCreates = server.requests.filter(request => /^POST .*\/merge_requests$/.test(request)).length;
    assert.equal(mrCreates, expectDenied ? 0 : 1);
    const readers = (await readFile(join(root, 'context-readers'), 'utf8')).trim().split('\n');
    assert.deepEqual(readers, expectDenied ? ['implementation', 'ac'] : ['implementation', 'ac', 'qa']);
    if (expectDenied) assert.deepEqual(pushes, []);
    else assert.ok(pushes.some(request => request.startsWith('POST ')));
    for (const { bare, seed } of repositories) {
      assert.equal(await git('-C', bare, 'rev-parse', 'main'), seed);
      if (expectDenied) assert.equal(await git('-C', bare, 'show-ref', '--heads'), `${seed} refs/heads/main`);
    }
    const inputPath = join(root, 'policy-input.json');
    await writeFile(inputPath, JSON.stringify(input));
    await assert.rejects(cli('plugin', 'invoke', 'policy.provider', 'compliance-policy', 'evaluate', '--input', inputPath, '--json'), error => {
      assert.equal(error.code, 1);
      const { allowed, rule } = JSON.parse(error.stdout);
      assert.deepEqual({ allowed, rule }, { allowed: false, rule: 'deny' });
      return true;
    });
    return { action, exit, status, integrityValid: true, runId: auditRuns[0], completed, readers,
      ...(failure && { failure: failure.reason }), receivePackRequests: pushes.length,
      mrCreates, repositories: repositories.length, freshDecision: 'deny' };
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
}

console.log(JSON.stringify({ version, platform: `${platform()}-${arch()}`,
  entrySha256: createHash('sha256').update(await readFile(entry)).digest('hex'),
  cases: [await qualify('tool.source.read', true), await qualify('publish', false)] }, null, 2));
