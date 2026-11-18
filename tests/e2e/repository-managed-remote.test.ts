import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, it } from 'vitest';
import { resolveE2eRuntime } from './installed-runtime.js';
import { branch, prepareRepositoryRun, startRepositoryServer } from './repository-managed-local.fixture.js';

const entry = process.env.AFK_E2E_CLI_ENTRY;

it.skipIf(!entry).each(['mounted', 'handle-only'] as const)('runs a described work item through the %s remote-workspace provider', async mode => {
  const installation = resolveE2eRuntime(entry);
  if (installation.mode !== 'installed') throw new Error('Expected installed CLI');
  const root = await realpath(await mkdtemp(join(tmpdir(), 'afk-remote-managed-')));
  const tracker = await startRepositoryServer(root);
  const sessions = new Map<string, string>();
  const receipts: Array<{ operation: string; name: string; claim: string; path: string }> = [];
  const fixture = await prepareRepositoryRun(root, tracker.host, installation.binary);
  const { cli, git, repositories, managed, manifest, workItemId } = fixture;
  const server = createServer(async (request, response) => {
    try {
      const [, , name, ...route] = new URL(request.url!, 'http://localhost').pathname.split('/');
      const repository = repositories.find(repo => repo.name === name)!;
      const operation = route.at(-1)!;
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
      const id = operation === 'prepare' ? `${name}-${body.runId}` : route[1];
      const runId = operation === 'prepare' ? body.runId : sessions.get(id);
      if (!runId || !/^[a-zA-Z0-9_.-]+$/.test(runId)) throw new Error('Unknown workspace');
      const path = join(managed, `${name}@${runId}`);
      const claim = JSON.parse(await readFile(join(repository.lock, 'claim.json'), 'utf8')).claimId;
      receipts.push({ operation, name, path, claim });
      const snapshot = async () => ({ commit: await git('-C', path, 'rev-parse', 'HEAD'), branch: await git('-C', path, 'rev-parse', '--abbrev-ref', 'HEAD'),
        dirty: !!await git('-C', path, 'status', '--porcelain', '--ignored', '--untracked-files=all') });
      let result;
      if (operation === 'prepare' || operation === 'checkout') {
        if (operation === 'prepare') {
          await git('-C', repository.config.path, 'fetch', 'origin');
          await git('-C', repository.config.path, 'worktree', 'add', '--detach', path, 'origin/main');
          sessions.set(id, runId);
        } else {
          await git('-C', path, 'switch', '-c', body.branch, `origin/${body.ref ?? 'main'}`);
        }
        result = { id, runId, repository: { url: name, ref: 'main' }, snapshot: await snapshot() };
      } else if (operation === 'snapshot') result = await snapshot();
      else {
        const state = await snapshot();
        if (state.dirty || body.expectedCommit !== state.commit || body.expectedBranch !== state.branch) throw new Error('Snapshot mismatch');
        if (operation === 'publish' && body.merge === false) {
          await git('-C', path, 'push', 'origin', `HEAD:refs/heads/${state.branch}`);
          result = { commit: state.commit, branch: state.branch };
        } else if (operation === 'cleanup') {
          await git('-C', repository.config.path, 'worktree', 'remove', path);
          sessions.delete(id);
          result = { removed: true };
        } else throw new Error('Unexpected operation');
      }
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify(result));
    } catch (error) { response.writeHead(500); response.end(String(error)); }
  });
  try {
    await new Promise<void>((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
    await mkdir(managed, { recursive: true });
    for (const { config } of repositories) await git('-C', config.path, 'remote', 'add', 'origin', config.remoteUrl);
    await writeFile(join(root, '.afk/plugins.yml'), JSON.stringify({ integrations: { repository: { provider: 'remote-workspace' } } }));
    const configFile = join(root, 'remote-config.json');
    await writeFile(configFile, JSON.stringify({ baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      ...(mode === 'mounted' && { managed: { workspaceRoot: managed, repositories: repositories.map(({ config }) => ({ name: config.name, leaseKey: config.leaseKey, remoteUrl: config.remoteUrl, gitDirectory: join(config.path, '.git') })) } }),
      lifecycle: { repositories: repositories.map(repo => ({ url: repo.name, ref: 'main' })), operations: ['prepare', 'checkout', 'publish', 'cleanup'] } }));
    await cli('plugin', 'configure', 'repository.remote-workspace', '--builtin', '--file', configFile);
    tracker.requests.length = 0;
    const run = cli('run', '--template', 'issue-implementation', '--agent', 'claude-code', '--execution-mode', 'batch', '--backlog-id', workItemId,
      '--execution-manifest', manifest, '--hard-timeout', '20000');
    if (mode === 'handle-only') {
      await expect(run).rejects.toMatchObject({ stderr: expect.stringContaining('requires lifecycle lease and read capabilities') });
      expect(receipts).toHaveLength(0);
      return;
    }
    await run;
    const [runId] = JSON.parse(await cli('observe', 'runs', '--json'));
    const observation = JSON.parse(await cli('observe', runId, '--json'));
    expect(observation).toMatchObject({ integrity: { valid: true }, state: { run: { status: 'awaiting_human' }, humanGateId: 'merge:2' } });
    expect(await readFile(join(root, 'context-readers'), 'utf8')).toBe('implementation\nac\nqa\n');
    const publications = [];
    const claims = new Set<string>();
    for (const { name, bare, seed, lock } of repositories) {
      const operations = receipts.filter(receipt => receipt.name === name);
      const agentPath = (await readFile(join(root, `${name}.path`), 'utf8')).trimEnd();
      expect(operations[0].path).toBe(agentPath);
      const claim = JSON.parse(await readFile(join(root, `${name}.claim`), 'utf8')).claimId;
      expect(claim).toEqual(expect.any(String));
      claims.add(claim);
      expect([...new Set(operations.map(receipt => receipt.claim))]).toEqual([claim]);
      const paths = new Set(operations.map(receipt => receipt.path));
      expect(paths.size).toBe(2);
      for (const path of paths) {
        expect(operations.filter(receipt => receipt.path === path).map(receipt => receipt.operation)).toEqual(['prepare', 'checkout', 'snapshot', 'publish', 'snapshot', 'cleanup']);
        await expect(lstat(path)).rejects.toMatchObject({ code: 'ENOENT' });
      }
      expect(await git('-C', bare, 'rev-parse', 'main')).toBe(seed);
      for (const ref of [branch, `${branch}-qa`]) {
        expect(await git('-C', bare, 'show', `${ref}:shared.txt`)).toBe(`applied ${name}`);
        publications.push({ name, ref, commit: await git('-C', bare, 'rev-parse', ref), base: seed });
      }
      expect(tracker.requests).toContain(`POST /acme/${name}.git/git-receive-pack`);
      await expect(lstat(lock)).rejects.toMatchObject({ code: 'ENOENT' });
    }
    expect(claims.size).toBe(repositories.length);
    expect(sessions.size).toBe(0);
    await writeFile(join(root, 'receipt.json'), JSON.stringify({ installation, workItemId, runId, integrity: observation.integrity, humanGate: observation.state.humanGateId,
      publications, releasedClaims: [...claims], remainingSessions: sessions.size, receipts }, null, 2));
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await tracker.close();
    if (process.env.AFK_E2E_KEEP_REPOSITORY === '1') console.info(`Remote workspace receipt directory: ${root}`);
    else await rm(root, { recursive: true, force: true });
  }
}, 90_000);
