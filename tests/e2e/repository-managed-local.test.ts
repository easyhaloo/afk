import { lstat, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { RunEvent } from '@afk/core';
import { expect, it } from 'vitest';
import { resolveE2eRuntime } from './installed-runtime.js';
import { branch, prepareRepositoryRun, startRepositoryServer } from './repository-managed-local.fixture.js';

const entry = process.env.AFK_E2E_CLI_ENTRY;

it.skipIf(!entry).each(['clean', 'unrelated ignored file'] as const)('enforces the installed multi-repository publication gate with a description: %s', async scenario => {
  const installation = resolveE2eRuntime(entry, process.env.AFK_E2E_RUNTIME_ROOT);
  if (installation.mode !== 'installed') throw new Error('An installed CLI is required');
  const root = await realpath(await mkdtemp(join(tmpdir(), 'afk-repository-managed-')));
  const server = await startRepositoryServer(root);
  try {
    const { repositories, cli, git, managed, workItemId, manifest } = await prepareRepositoryRun(root, server.host, installation.binary, scenario !== 'clean');
    const read = async (name: string) => (await readFile(join(root, name), 'utf8')).trim();
    server.requests.length = 0;
    const publication = cli('run', '--template', 'issue-implementation', '--agent', 'claude-code', '--execution-mode', 'batch',
      '--backlog-id', workItemId, '--execution-manifest', manifest, '--hard-timeout', '20000');
    if (scenario !== 'clean') {
      await expect(publication).rejects.toMatchObject({ stderr: expect.stringContaining('repository publication failed: refusing operation on dirty repository workspace') });
      const primary = await read('primary');
      expect(await git('-C', primary, 'status', '--porcelain', '--ignored', '--untracked-files=all')).toBe('!! .afk/unowned.txt');
      expect(await readFile(join(primary, '.afk/unowned.txt'), 'utf8')).toBe('preserve\n');
      expect(await read('context-readers')).toBe('implementation\nac');
      expect(server.requests.filter(request => request.startsWith('POST') && /git-receive-pack|merge_requests/.test(request))).toEqual([]);
      for (const { bare, seed } of repositories) expect(await git('-C', bare, 'show-ref', '--heads')).toBe(`${seed} refs/heads/main`);
      return;
    }
    await publication;
    expect(await read('context-readers')).toBe('implementation\nac\nqa');
    const runs: string[] = JSON.parse(await cli('observe', 'runs', '--json'));
    expect(runs).toHaveLength(1);
    const observation = JSON.parse(await cli('observe', runs[0]!, '--json'));
    expect(observation).toMatchObject({ integrity: { valid: true }, state: { run: { status: 'awaiting_human' }, humanGateId: 'merge:2' } });
    const history: RunEvent[] = observation.events;
    expect(history.every(event => event.context.workItemId === workItemId)).toBe(true);
    const events = history.map(event => event.data);
    expect(events).toContainEqual(expect.objectContaining({ kind: 'workflow.recorded', name: 'issue-implementation' }));
    expect(events).toContainEqual({ kind: 'qa.passed' });
    expect(events).toContainEqual({ kind: 'change.published', changeId: '2', url: `http://${server.host}/acme/api/-/merge_requests/2` });
    const claims = new Set<string>();
    const published = [];
    for (const { name, config, bare, seed, lock } of repositories) {
      const path = await read(`${name}.path`);
      expect(dirname(path)).toBe(managed);
      if (name === 'api') expect(await read('primary')).toBe(path);
      expect(await read(`${name}.head`)).toBe(seed);
      expect(await read(`${name}.branch`)).toBe(branch);
      expect(await read(`${name}.origin`)).toBe(config.remoteUrl);
      const claim = JSON.parse(await read(`${name}.claim`));
      expect(claim.claimId).toEqual(expect.any(String));
      claims.add(claim.claimId);
      await expect(lstat(lock)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(lstat(path)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(server.requests).toContain(`POST /acme/${name}.git/git-upload-pack`);
      expect(server.requests).toContain(`POST /acme/${name}.git/git-receive-pack`);
      const revision = await git('-C', bare, 'rev-parse', branch);
      expect(await git('-C', bare, 'rev-parse', `${revision}^`)).toBe(seed);
      expect(await git('-C', bare, 'rev-parse', 'main')).toBe(seed);
      expect(await git('-C', bare, 'show', `${revision}:shared.txt`)).toBe(`applied ${name}`);
      expect(await git('-C', bare, 'ls-tree', '-r', '--name-only', revision)).toBe('shared.txt');
      expect(await git('-C', bare, 'ls-tree', '-r', '--name-only', `${branch}-qa`)).toBe('shared.txt');
      expect(events).toContainEqual(expect.objectContaining({ kind: 'commit.recorded', phase: 'implementation', branch, commitSha: revision }));
      if (name === 'api') {
        const verified = await git('-C', bare, 'rev-parse', `${branch}-qa`);
        expect(events).toContainEqual(expect.objectContaining({ kind: 'decision.made', command: 'experience.qa-target', accepted: true,
          reason: JSON.stringify({ target: { project: `gitlab:${server.host}/acme/api`, revision: verified, dirty: false } }) }));
      }
      published.push({ name, origin: config.remoteUrl, path, seed, branch, revision, claimId: claim.claimId });
    }
    expect(claims.size).toBe(repositories.length);
    if (process.env.AFK_E2E_KEEP_REPOSITORY === '1') {
      await writeFile(join(root, 'receipt.json'), JSON.stringify({ installation, workItemId, runId: runs[0],
        integrity: observation.integrity, outcome: observation.state.run.status, repositories: published, requests: server.requests }, null, 2));
    }
  } finally {
    await server.close();
    if (process.env.AFK_E2E_KEEP_REPOSITORY === '1') console.info(`Repository lifecycle evidence: ${root}`);
    else await rm(root, { recursive: true, force: true });
  }
}, 90_000);
