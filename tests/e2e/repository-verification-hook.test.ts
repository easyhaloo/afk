import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { RunEvent } from '@afk/core';
import { expect, it } from 'vitest';
import { resolveE2eRuntime } from './installed-runtime.js';
import { branch, prepareRepositoryRun, startRepositoryServer } from './repository-managed-local.fixture.js';

const entry = process.env.AFK_E2E_CLI_ENTRY;

const policyCases = ['secret-scan', 'license-policy', 'compliance-policy'].flatMap(provider => [false, true].map(denied => ({ provider, denied })));
it.skipIf(!entry).each(policyCases)('enforces $provider before repository publication (denied=$denied)', async ({ provider, denied }) => {
  const installation = resolveE2eRuntime(entry);
  if (installation.mode !== 'installed') throw new Error('An installed CLI is required');
  const root = await realpath(await mkdtemp(join(tmpdir(), 'repository-policy-')));
  const pushes: string[] = [];
  const server = await startRepositoryServer(root, request => pushes.push(request));
  try {
    const { cli, git, repositories, workItemId, manifest } = await prepareRepositoryRun(root, server.host, installation.binary, false, undefined, provider);
    const synthetic = 'synthetic-gate-marker';
    if (denied && provider === 'secret-scan') await writeFile(join(root, 'web.shared.txt'), `password=${synthetic}\n`);
    const settings = {
      'secret-scan': { root, files: ['shared.txt'] },
      'license-policy': { allowlist: ['MIT'], licenses: [denied ? 'LicenseRef-Unknown' : 'MIT'] },
      'compliance-policy': { rules: [{ id: 'publish-review', actions: ['publish'], effect: denied ? 'deny' : 'allow' }] },
    };
    const configPath = join(root, 'policy.json');
    await writeFile(configPath, JSON.stringify(settings[provider as keyof typeof settings]));
    await cli('plugin', 'configure', `policy.${provider}`, '--builtin', '--file', configPath);
    pushes.length = 0;
    server.requests.length = 0;
    const run = cli('run', '--template', 'issue-implementation', '--agent', 'claude-code', '--execution-mode', 'batch',
      '--backlog-id', workItemId, '--execution-manifest', manifest, '--hard-timeout', '20000');
    if (denied) {
      await expect(run).rejects.toMatchObject({ stderr: expect.stringContaining('Execution denied by capability policy') });
      await expect(run).rejects.toMatchObject({ stderr: expect.not.stringContaining(synthetic), stdout: expect.not.stringContaining(synthetic) });
      expect(pushes).toEqual([]);
      expect(server.requests.filter(request => request.startsWith('POST') && request.endsWith('/merge_requests'))).toEqual([]);
      const readers = readFile(join(root, 'context-readers'), 'utf8');
      if (provider === 'secret-scan') await expect(readers).resolves.toContain('implementation');
      else await expect(readers).rejects.toMatchObject({ code: 'ENOENT' });
    } else await run;
    const runs = JSON.parse(await cli('observe', 'runs', '--json'));
    expect(runs).toHaveLength(1);
    const observation = await cli('observe', runs[0], '--json');
    expect(observation).not.toContain(synthetic);
    expect(JSON.parse(observation)).toMatchObject({ integrity: { valid: true }, state: { run: { status: denied ? 'failed' : 'awaiting_human' } } });
    for (const { bare, seed } of repositories) {
      if (denied) expect(await git('-C', bare, 'show-ref', '--heads')).toBe(`${seed} refs/heads/main`);
      else expect(await git('-C', bare, 'rev-parse', `${branch}^`)).toBe(seed);
    }
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
}, 90_000);

it.skipIf(!entry).each([true, false])('audits configured verification before repository publication (passes=%s)', async passes => {
  const installation = resolveE2eRuntime(entry, process.env.AFK_E2E_RUNTIME_ROOT);
  if (installation.mode !== 'installed') throw new Error('An installed CLI is required');
  const root = await realpath(await mkdtemp(join(tmpdir(), 'repository-verification-')));
  const server = await startRepositoryServer(root);
  try {
    const command = ['/usr/bin/grep', '-Exq', passes ? 'applied (api|web)' : 'missing change', 'shared.txt'];
    const { cli, git, repositories, workItemId, manifest } = await prepareRepositoryRun(root, server.host, installation.binary, false, command);
    server.requests.length = 0;
    const run = cli('run', '--template', 'issue-implementation', '--agent', 'claude-code', '--execution-mode', 'batch',
      '--backlog-id', workItemId, '--execution-manifest', manifest, '--hard-timeout', '20000');
    if (passes) await run;
    else await expect(run).rejects.toMatchObject({ stderr: expect.stringContaining('Capability verification failed') });
    const runs = JSON.parse(await cli('observe', 'runs', '--json'));
    expect(runs).toHaveLength(1);
    const observed = JSON.parse(await cli('observe', runs[0], '--json'));
    expect(observed.integrity.valid).toBe(true);
    const events: RunEvent[] = observed.events;
    const completed = events.filter(({ data }) => data.kind === 'effect.completed' && data.effectKind === 'verification');
    expect(completed.length).toBeGreaterThan(0);
    const { createLocalEncryptedEvidenceStore } = await import(pathToFileURL(join(installation.runtime, 'infrastructure/observability/local-evidence-store.js')).href);
    const store = await createLocalEncryptedEvidenceStore(root);
    const phases = new Set<string>();
    for (const event of completed) {
      expect(event.evidence).toHaveLength(1);
      const receipt = JSON.parse(Buffer.from(await store.get(event.evidence![0])).toString());
      expect(receipt).toMatchObject({ protocol: 'capability-verification-v1', provider: 'test-runner', executionId: event.idempotencyKey,
        observation: { runId: runs[0], workItemId }, outcome: passes ? 'succeeded' : 'failed',
        result: { passed: passes, execution: { command, cwd: receipt.workspace, closed: true, exitCode: passes ? 0 : 1 } } });
      expect(receipt.revision.before.head).toMatch(/^[0-9a-f]{40}$/);
      expect(receipt.revision.after).toEqual(receipt.revision.before);
      phases.add(receipt.phase);
    }
    expect(phases).toEqual(new Set(passes ? ['after-agent', 'before-publish'] : ['before-publish']));
    if (passes) expect(observed.state.run.status).toBe('awaiting_human');
    else expect(server.requests.filter(request => request.startsWith('POST') && /git-receive-pack|merge_requests/.test(request))).toEqual([]);
    for (const { bare, seed } of repositories) {
      expect(await git('-C', bare, 'rev-parse', 'main')).toBe(seed);
      if (passes) expect(await git('-C', bare, 'rev-parse', `${branch}^`)).toBe(seed);
      else expect(await git('-C', bare, 'show-ref', '--heads')).toBe(`${seed} refs/heads/main`);
    }
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
}, 90_000);
