import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { branch, prepareRepositoryRun, startRepositoryServer } from '../../e2e/repository-managed-local.fixture.ts';

process.umask(0o077);
const [launcher, playwrightPath, chromiumPath] = process.argv.slice(2);
assert.ok(chromiumPath, 'Usage: node browser-publish.mjs INSTALLED_AFK PLAYWRIGHT_TEST_DIR CHROMIUM > receipt.json');
const [entry, playwright, chromium] = await Promise.all([launcher, playwrightPath, chromiumPath].map(path => realpath(path)));
const release = dirname(dirname(entry));
assert.equal(entry, join(release, 'dist/index.js'));
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const { version, platform, arch } = await json(join(release, 'release.json'));
const storePath = await realpath(join(release, 'node_modules/@afk/runtime/dist/infrastructure/observability/local-evidence-store.js'));
assert.ok(storePath.startsWith(`${release}/`));
const { createLocalEncryptedEvidenceStore } = await import(pathToFileURL(storePath));
const yaml = createRequire(storePath)('js-yaml');
const probe = fileURLToPath(new URL('./browser-publish-probe.mjs', import.meta.url));
const html = `<!doctype html><meta charset="utf-8"><title>Parcel</title>
<link rel="stylesheet" href="parcel.css">
<button onclick="document.querySelector('output').textContent='Parcel ready'">Check parcel</button>
<output>Pending</output>\n`;

async function qualify(visible) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'browser-publish-')));
  const pushes = [];
  const server = await startRepositoryServer(root, request => pushes.push(request));
  try {
    const { repositories, cli, git, manifest, workItemId } = await prepareRepositoryRun(root, server.host, entry);
    assert.equal((await cli('--version')).trim(), version);
    const css = `output { display: ${visible ? 'block' : 'none'}; }\n`;
    await writeFile(join(root, 'parcel.html'), html);
    await writeFile(join(root, 'parcel.css'), css);
    const hooks = join(root, 'candidate-hooks');
    await mkdir(hooks);
    await writeFile(join(hooks, 'pre-commit'), `#!/bin/sh
set -eu
if test ! -f parcel.html && git diff --cached --name-only | grep -Fxq shared.txt; then
  cp "$HOME/parcel.html" "$HOME/parcel.css" .
  git add parcel.html parcel.css
fi
`, { mode: 0o700 });
    await git('config', '--global', 'core.hooksPath', hooks);
    const command = [process.execPath, probe, playwright, chromium, root];
    const configPath = join(root, '.afk/plugins.yml');
    const config = yaml.load(await readFile(configPath, 'utf8'));
    config.integrations.verifications = [{ provider: 'browser-check', command, timeoutMs: 25000 }];
    await writeFile(configPath, JSON.stringify(config));
    pushes.length = 0;
    server.requests.length = 0;
    let cliExit = 0;
    try {
      await cli('run', '--template', 'issue-implementation', '--agent', 'claude-code', '--execution-mode', 'batch',
        '--backlog-id', workItemId, '--execution-manifest', manifest, '--hard-timeout', '35000');
    } catch (error) {
      if (visible || !error.stderr?.includes('Capability verification failed')) throw error;
      cliExit = error.code;
    }
    assert.equal(cliExit, visible ? 0 : 1);
    const runs = JSON.parse(await cli('observe', 'runs', '--json'));
    assert.equal(runs.length, 1);
    const observed = JSON.parse(await cli('observe', runs[0], '--json'));
    assert.equal(observed.integrity.valid, true);
    const store = await createLocalEncryptedEvidenceStore(root);
    const gates = [];
    for (const event of observed.events.filter(({ data }) => data.kind === 'effect.completed' && data.effectKind === 'verification')) {
      assert.equal(event.evidence.length, 1);
      const receipt = JSON.parse(await store.get(event.evidence[0]));
      assert.equal(receipt.protocol, 'capability-verification-v1');
      assert.equal(receipt.provider, 'browser-check');
      assert.equal(receipt.observation.runId, runs[0]);
      assert.equal(receipt.observation.workItemId, workItemId);
      assert.equal(receipt.executionId, event.idempotencyKey);
      assert.equal(receipt.outcome, visible ? 'succeeded' : 'failed');
      assert.equal(event.data.outcome, receipt.outcome);
      assert.deepEqual(receipt.failures.map(failure => failure.classification), visible ? [] : ['verification-failed']);
      assert.deepEqual(receipt.revision.after, receipt.revision.before);
      const { execution, passed } = receipt.result;
      assert.equal(execution.executionId, receipt.executionId);
      assert.equal(execution.cwd, receipt.workspace);
      assert.deepEqual(execution.command, command);
      assert.equal(execution.closed, true);
      assert.equal(execution.exitCode, visible ? 0 : 1);
      assert.equal(passed, visible);
      const render = JSON.parse(execution.stdout);
      assert.equal(render.revision, receipt.revision.before.head);
      assert.equal(render.text, 'Parcel ready');
      assert.equal(render.visible, visible);
      assert.equal(render.width > 0, visible);
      assert.equal(render.browserExit, 0);
      gates.push({ phase: receipt.phase, branch: receipt.revision.before.branch, passed, closed: execution.closed,
        exitCode: execution.exitCode, evidenceSha256: event.evidence[0].sha256, ...render });
    }
    assert.deepEqual(new Set(gates.map(gate => gate.phase)), new Set(visible ? ['before-publish', 'after-agent'] : ['before-publish']));
    const postPush = pushes.filter(request => request.startsWith('POST ')).length;
    const mrCreates = server.requests.filter(request => /^POST .*\/merge_requests$/.test(request)).length;
    assert.equal(mrCreates, visible ? 1 : 0);
    const events = observed.events.map(event => event.data);
    assert.equal(events.some(event => event.kind === 'change.published'), visible);
    if (visible) {
      assert.ok(postPush > 0);
      assert.equal(observed.state.humanGateId, 'merge:2');
      assert.equal(observed.state.run.status, 'awaiting_human');
    } else {
      assert.equal(observed.state.run.status, 'failed');
      assert.deepEqual(pushes, []);
    }
    const remotes = [];
    for (const { bare, name, seed } of repositories) {
      assert.equal(await git('-C', bare, 'rev-parse', 'main'), seed);
      const refs = await git('-C', bare, 'show-ref', '--heads');
      if (!visible) assert.equal(refs, `${seed} refs/heads/main`);
      else {
        const head = await git('-C', bare, 'rev-parse', branch);
        assert.equal(await git('-C', bare, 'rev-parse', `${head}^`), seed);
        assert.equal(await git('-C', bare, 'show', `${head}:parcel.html`), html.trim());
        assert.equal(await git('-C', bare, 'show', `${head}:parcel.css`), css.trim());
        const qaHead = await git('-C', bare, 'rev-parse', `${branch}-qa`);
        for (const published of [head, qaHead]) {
          const gate = gates.find(gate => gate.phase === 'before-publish' && gate.revision === published);
          assert.ok(gate, `${name} remote commit missing from before-publish evidence`);
          for (const [file, blob] of Object.entries(gate.blobs)) {
            assert.equal(await git('-C', bare, 'rev-parse', `${published}:${file}`), blob);
          }
        }
      }
      remotes.push({ name, refs: Object.fromEntries(refs.split('\n').map(line => line.split(' ').reverse())) });
    }
    return { dom: visible ? 'repaired' : 'hidden', cliExit, status: observed.state.run.status, integrityValid: true, gates,
      receivePackRequests: pushes.length, receivePackPosts: postPush, mrCreates, remotes };
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
}

const cases = [await qualify(false), await qualify(true)];
assert.equal(cases[0].gates[0].blobs['parcel.html'], cases[1].gates[0].blobs['parcel.html']);
assert.notEqual(cases[0].gates[0].blobs['parcel.css'], cases[1].gates[0].blobs['parcel.css']);
console.log(JSON.stringify({ version, platform, arch, launcherSha256: createHash('sha256').update(await readFile(entry)).digest('hex'),
  playwright: (await json(join(playwright, 'package.json'))).version, node: process.version, provider: 'verification.browser-check',
  agent: 'synthetic repository fixture', tracker: 'loopback GitLab fixture', remote: 'Git HTTP bare repositories', cases }, null, 2));
