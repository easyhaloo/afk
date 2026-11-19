import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { resolveE2eRuntime } from './installed-runtime.js';
import { branch, prepareRepositoryRun, startRepositoryServer } from './repository-managed-local.fixture.js';

const entry = process.env.AFK_E2E_CLI_ENTRY;

it.skipIf(!entry)('routes implementation and QA through leased command-backend worktrees after a failed checkout', async () => {
  const installation = resolveE2eRuntime(entry);
  if (installation.mode !== 'installed') throw new Error('Expected installed CLI');
  const root = await realpath(await mkdtemp(join(tmpdir(), 'afk-command-managed-')));
  const tracker = await startRepositoryServer(root);
  try {
    const { repositories, cli, git, managed, workItemId, manifest } = await prepareRepositoryRun(root, tracker.host, installation.binary);
    const backend = join(root, 'git-backend');
    await copyFile(new URL('./repository-managed-command.fixture.py', import.meta.url), backend);
    await chmod(backend, 0o700);
    await mkdir(managed);
    await writeFile(join(root, 'locks.json'), JSON.stringify(Object.fromEntries(repositories.map(repo => [repo.name, repo.lock]))));
    for (const { config } of repositories) await git('-C', config.path, 'remote', 'add', 'origin', config.remoteUrl);
    await writeFile(join(root, '.afk/plugins.yml'), JSON.stringify({ integrations: { repository: { provider: 'special-git-backend' } } }));
    const configFile = join(root, 'backend.json');
    await writeFile(configFile, JSON.stringify({ backend, lifecycle: { repositories: repositories.map(repo => ({ url: repo.name, ref: 'main' })),
      operations: ['prepare', 'checkout', 'publish', 'cleanup'] }, managed: { workspaceRoot: managed,
      repositories: repositories.map(({ config }) => ({ name: config.name, gitDirectory: join(config.path, '.git'), leaseKey: config.leaseKey, remoteUrl: config.remoteUrl })) } }));
    await cli('plugin', 'configure', 'repository.special-git-backend', '--builtin', '--file', configFile);
    const run = () => cli('run', '--template', 'issue-implementation', '--agent', 'claude-code', '--execution-mode', 'batch',
      '--backlog-id', workItemId, '--execution-manifest', manifest, '--hard-timeout', '20000');
    const operations = async () => (await readFile(join(root, 'operations.jsonl'), 'utf8')).trimEnd().split('\n')
      .map(line => JSON.parse(line) as { operation: string; name: string; claim: string; path: string });
    await writeFile(join(root, 'fail-checkout'), 'once');
    await expect(run()).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('special git backend lifecycle command failed') });
    const failed = await operations();
    expect(failed.map(row => row.operation)).toEqual(['prepare', 'checkout', 'snapshot', 'cleanup']);
    expect(await readdir(managed)).toEqual([]);
    for (const { bare, lock, seed } of repositories) {
      expect(await git('-C', bare, 'show-ref', '--heads')).toBe(`${seed} refs/heads/main`);
      await expect(lstat(lock)).rejects.toMatchObject({ code: 'ENOENT' });
    }
    await rm(join(root, 'fail-checkout'));
    await cli('backlog', 'retry', '--id', '1', '--project', `${tracker.host}/acme/api`, '--platform', 'gitlab', '--reason', 'Local checkout backend recovered');
    await run();
    const completed = (await operations()).slice(failed.length);
    const publications = [];
    const claims = new Set<string>();
    for (const { name, bare, seed, lock } of repositories) {
      const rows = completed.filter(row => row.name === name);
      const claim = JSON.parse(await readFile(join(root, `${name}.claim`), 'utf8')).claimId;
      expect(claim).toEqual(expect.any(String));
      claims.add(claim);
      expect(new Set(rows.map(row => row.claim))).toEqual(new Set([claim]));
      expect(rows[0]?.path).toBe((await readFile(join(root, `${name}.path`), 'utf8')).trimEnd());
      const paths = new Set(rows.map(row => row.path));
      expect(paths.size).toBe(2);
      for (const path of paths) expect(rows.filter(row => row.path === path).map(row => row.operation))
        .toEqual(['prepare', 'checkout', 'snapshot', 'publish', 'snapshot', 'cleanup']);
      expect(await git('-C', bare, 'rev-parse', 'main')).toBe(seed);
      for (const ref of [branch, `${branch}-qa`]) {
        expect(await git('-C', bare, 'show', `${ref}:shared.txt`)).toBe(`applied ${name}`);
        publications.push({ name, ref, commit: await git('-C', bare, 'rev-parse', ref), base: seed });
      }
      await expect(lstat(lock)).rejects.toMatchObject({ code: 'ENOENT' });
    }
    expect(claims.size).toBe(repositories.length);
    expect(await readdir(managed)).toEqual([]);
    expect(await readFile(join(root, 'context-readers'), 'utf8')).toBe('implementation\nac\nqa\n');
    const runs: string[] = JSON.parse(await cli('observe', 'runs', '--json'));
    const observations = await Promise.all(runs.map(async id => JSON.parse(await cli('observe', id, '--json'))));
    expect(observations).toContainEqual(expect.objectContaining({ integrity: expect.objectContaining({ valid: true }),
      state: expect.objectContaining({ run: expect.objectContaining({ status: 'awaiting_human' }), humanGateId: 'merge:2' }) }));
    console.info(JSON.stringify({ version: installation.version, failed: failed.map(row => row.operation),
      releasedClaims: claims.size, managedPaths: new Set(completed.map(row => row.path)).size, publications, humanGate: 'merge:2' }));
  } finally {
    await tracker.close();
    await rm(root, { recursive: true, force: true });
  }
}, 90_000);
