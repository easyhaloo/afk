import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vitest';
import type { RunEvent } from '@afk/core';

const execute = promisify(execFile);
const cliEntry = resolve(process.env.AFK_E2E_CLI_ENTRY ?? 'apps/cli/dist/index.js');
const runtime = resolve(process.env.AFK_E2E_RUNTIME_ROOT ?? 'packages/runtime/dist');
const roots: string[] = [];
const workItemId = 'github:acme/learning-route#42';

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

interface AuditedRun {
  runId: string;
  events: RunEvent[];
  verification: { valid: boolean; lastSequence: number; lastHash?: string };
}

async function fixture(selection: 'explicit' | 'configured' = 'explicit') {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'plugin-learning-route-e2e-')));
  roots.push(root);
  const home = join(root, 'home');
  const cwd = join(root, 'workspace');
  const bin = join(root, 'empty-bin');
  const managed = join(root, 'managed-worktrees');
  await Promise.all([fs.mkdir(join(home, '.afk', 'workflows'), { recursive: true }), fs.mkdir(cwd), fs.mkdir(bin)]);
  const template = join(home, '.afk', 'workflows', 'local-settings.yml');
  await fs.writeFile(template, JSON.stringify({ name: 'local-settings', version: 1, purpose: 'learning',
    steps: [{ id: 'settings', kind: 'system', action: 'learning.settings', input: {} }] }));
  await fs.writeFile(join(home, '.afk', 'config.yml'), JSON.stringify({ agentDefault: 'uninstalled-route-agent',
    template: selection === 'configured' ? 'local-settings' : 'issue-implementation' }));
  const configuration = join(root, 'learning-plugin.json');
  await fs.writeFile(configuration, JSON.stringify({ enabled: false, dailyCalls: 0 }), { mode: 0o600 });
  const env = { HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, '.config'),
    XDG_CACHE_HOME: join(home, '.cache'), XDG_STATE_HOME: join(home, '.local', 'state'), PATH: bin,
    AFK_EVENT_STORE_DIR: join(root, 'events'), AFK_LOG_DIR: join(root, 'logs'), AFK_WORKTREE_DIR: managed,
    NO_COLOR: '1', LANG: 'C', LC_ALL: 'C' };
  const command = (...args: string[]) => execute(process.execPath, [cliEntry, ...args], { cwd, env, timeout: 15_000 });
  await command('plugin', 'configure', 'learning.distiller', '--builtin', '--file', configuration);
  const auditModule = pathToFileURL(join(runtime, 'infrastructure/observability/jsonl-event-store.js')).href;
  const audit = async (): Promise<AuditedRun[]> => JSON.parse((await execute(process.execPath,
    ['--input-type=module', '--eval', `
      import { JsonlEventStore } from ${JSON.stringify(auditModule)};
      const store = new JsonlEventStore({ root: process.env.AFK_EVENT_STORE_DIR });
      const runs = [];
      for (const runId of await store.listRuns()) {
        const events = [];
        for await (const event of store.read(runId)) events.push(event);
        runs.push({ runId, events, verification: await store.verify(runId) });
      }
      console.log(JSON.stringify(runs));
    `], { cwd, env, timeout: 15_000 })).stdout);
  const assertNoManagedWorkspace = async () => {
    expect(await fs.readdir(cwd)).toEqual([]);
    await expect(fs.access(managed)).rejects.toMatchObject({ code: 'ENOENT' });
  };
  const run = (...args: string[]) => command('run', '--backlog-id', workItemId,
    ...(selection === 'explicit' ? ['--template', template] : []), ...args);
  expect(await audit()).toEqual([]);
  await assertNoManagedWorkspace();
  return { run, command, audit, assertNoManagedWorkspace, missingManifest: join(root, 'missing-manifest.json') };
}

it.each(['success', 'repair'] as const)('routes compiled %s review through learning and fails safely when learning is disabled', async kind => {
  const test = await fixture();
  const options = ['--backlog-id', workItemId, '--run-id', 'private-source-run', '--checker', 'private-checker', '--kind', kind, '--json'];
  await expect(test.command('experience', 'review', ...options)).rejects.toMatchObject({ code: 1, stdout: '',
    stderr: expect.stringContaining('Learning review failed') });
  await test.assertNoManagedWorkspace();
  const runs = await test.audit();
  expect(runs).toHaveLength(1);
  const review = runs[0]!;
  expect(review.runId).not.toBe('private-source-run');
  expect(review.verification.valid).toBe(true);
  expect(review.events.every(event => event.context.purpose === 'learning' && event.context.workItemId === workItemId)).toBe(true);
  expect(review.events.map(event => event.data)).toEqual(expect.arrayContaining([
    expect.objectContaining({ kind: 'workflow.recorded', name: `${kind}-review-preview` }),
    expect.objectContaining({ kind: 'effect.completed', effectKind: 'learning.retrospective', outcome: 'failed' }),
  ]));
  expect(review.events.at(-1)?.data).toMatchObject({ kind: 'run.finished', outcome: 'failed' });
}, 60_000);

it.each(['explicit', 'configured'] as const)(
  'runs a %s learning template through the compiled CLI without an installed Agent or Git workspace', async selection => {
    const test = await fixture(selection);
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await test.run();
      expect(result.stdout).toContain('Workflow completed');
      await test.assertNoManagedWorkspace();
    }
    const runs = await test.audit();
    expect(runs).toHaveLength(2);
    expect(new Set(runs.map(run => run.runId)).size).toBe(2);
    for (const run of runs) {
      expect(run.runId).not.toBe(workItemId);
      expect(run.events.length).toBeGreaterThan(4);
      expect(run.events.every(event => event.context.runId === run.runId
        && event.context.workItemId === workItemId && event.context.purpose === 'learning')).toBe(true);
      expect(run.events.map(event => event.data)).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'run.requested', run: expect.objectContaining({ id: run.runId, workItemId }) }),
        expect.objectContaining({ kind: 'run.started' }),
        expect.objectContaining({ kind: 'workflow.recorded', name: 'local-settings' }),
        expect.objectContaining({ kind: 'effect.started', effectKind: 'learning.settings' }),
        expect.objectContaining({ kind: 'effect.completed', effectKind: 'learning.settings', outcome: 'succeeded' }),
      ]));
      expect(run.events.at(-1)?.data).toMatchObject({ kind: 'run.finished', outcome: 'succeeded' });
      expect(run.verification).toMatchObject({ valid: true, lastSequence: run.events.at(-1)?.sequence,
        lastHash: run.events.at(-1)?.integrity.hash });
      expect(run.verification.lastHash).toMatch(/^[a-f0-9]{64}$/);
    }
  }, 60_000,
);

it.each([
  ['--target-branch', 'feature/learning'],
  ['--base-branch', 'main'],
  ['--sandbox', 'local'],
  ['--agent', 'uninstalled-route-agent'],
  ['--execution-mode', 'batch'],
  ['--agent-transport', 'exec'],
  ['--agent-auth', 'api'],
  ['--agent-provider', 'custom'],
  ['--agent-profile', 'work'],
  ['--agent-app-server', 'ws://127.0.0.1:4500'],
  ['--agent-app-server-auth-env', 'LEARNING_ROUTE_TEST_TOKEN'],
])('rejects explicit %s before learning effects or managed preparation', async (flag, value) => {
  const test = await fixture();
  await expect(test.run(flag, value)).rejects.toMatchObject({ code: 1,
    stderr: expect.stringContaining('learning templates cannot use execution branch, sandbox or agent options') });
  expect(await test.audit()).toEqual([]);
  await test.assertNoManagedWorkspace();
});

it('rejects an execution manifest before reading it or producing learning effects', async () => {
  const test = await fixture('configured');
  await expect(test.run('--execution-manifest', test.missingManifest)).rejects.toMatchObject({ code: 1,
    stderr: expect.stringContaining('learning templates cannot use an execution manifest') });
  expect(await test.audit()).toEqual([]);
  await test.assertNoManagedWorkspace();
});
