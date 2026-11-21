import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RunEvent } from '@afk/core';
import { expect, it } from 'vitest';
import { resolveE2eRuntime } from './installed-runtime.js';
import { prepareRepositoryRun, startRepositoryServer } from './repository-managed-local.fixture.js';

it.skipIf(!process.env.AFK_E2E_CLI_ENTRY)('replays a rejected second repository as a failed run', async () => {
  const installation = resolveE2eRuntime(process.env.AFK_E2E_CLI_ENTRY);
  if (installation.mode !== 'installed') throw new Error('Installed CLI required');
  const root = await realpath(await mkdtemp(join(tmpdir(), 'afk-verification-replay-')));
  const server = await startRepositoryServer(root);
  try {
    const { cli, git, repositories, workItemId, manifest } = await prepareRepositoryRun(root, server.host, installation.binary,
      false, ['/usr/bin/grep', '-Fxq', 'applied api', 'shared.txt']);
    server.requests.length = 0;
    await expect(cli('run', '--template', 'issue-implementation', '--agent', 'claude-code', '--execution-mode', 'batch',
      '--backlog-id', workItemId, '--execution-manifest', manifest, '--hard-timeout', '35000'))
      .rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('Capability verification failed') });
    expect(server.requests.filter(request => request.startsWith('POST') && /git-receive-pack|merge_requests$/.test(request))).toEqual([]);
    for (const { bare, seed } of repositories) expect(await git('-C', bare, 'show-ref', '--heads')).toBe(`${seed} refs/heads/main`);

    const runs: string[] = JSON.parse(await cli('observe', 'runs', '--json'));
    expect(runs).toHaveLength(1);
    const [runId] = runs;
    if (process.env.AFK_E2E_KEEP_REPOSITORY === '1') console.info(`Replay fixture: ${root} ${runId}`);
    const integrity = JSON.parse(await cli('observe', 'verify', runId!, '--json'));
    expect(integrity.valid).toBe(true);
    const observed = JSON.parse(await cli('observe', runId!, '--json'));
    const replayed = JSON.parse(await cli('observe', 'replay', runId!, '--json'));
    expect(replayed.state).toEqual(observed.state);
    expect(observed.state).toMatchObject({ terminal: true, sequence: integrity.lastSequence, run: { id: runId, workItemId, status: 'failed' } });
    const events: RunEvent[] = observed.events;
    const verifications = events.filter(({ data }) => data.kind === 'effect.completed' && data.effectKind === 'verification');
    expect(verifications.at(-1)?.data).toMatchObject({ outcome: 'failed' });
    expect(verifications.at(-1)?.evidence).toHaveLength(1);
    expect(events.at(-1)?.data).toMatchObject({ kind: 'run.finished', outcome: 'failed', reason: expect.stringContaining('Capability verification failed') });
  } finally {
    await server.close();
    if (process.env.AFK_E2E_KEEP_REPOSITORY !== '1') await rm(root, { recursive: true, force: true });
  }
}, 90_000);
