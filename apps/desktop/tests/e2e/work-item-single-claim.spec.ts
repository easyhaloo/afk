import { test, expect, _electron as electron } from '@playwright/test';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { withRepositoryFixture } from '../../../../tests/e2e/workflow-templates.fixture.js';
import { RENDERER_URL } from './_helpers/launch.js';

const desktop = fileURLToPath(new URL('../../', import.meta.url));
const entry = resolve(process.env.AFK_E2E_CLI_ENTRY ?? join(desktop, '../cli/dist/index.js'));
const execute = promisify(execFile);

test('CLI and Desktop contend for one work item and recover after an agent failure', async ({}, info) => {
  await withRepositoryFixture(false, true, async ({ root, checkout, host, workItemId, env, requests, labels }) => {
    const cli = (...args: string[]) => execute(process.execPath, [entry, ...args], { cwd: root, env, timeout: 25_000 });
    const run = (id: string) => cli('execute', '--work-item-id', workItemId, '--execution-id', id, '--execution-mode', 'batch');
    const text = (name: string) => readFile(join(root, name), 'utf8');
    const tool = join(root, 'bin/claude');
    await rename(tool, `${tool}-success`);
    await writeFile(tool, `#!/bin/sh
set -eu
case "$1" in --version|-v) echo '2.1.0'; exit 0;; esac
echo "$$" >> "$HOME/launches"
if ! test -f "$HOME/release"; then
  cat >/dev/null
  for delay in $(seq 1 200); do test -f "$HOME/release" && exit 1; sleep 0.1; done
  exit 2
fi
exec "$HOME/bin/claude-success" "$@"
`, { mode: 0o700 });
    const workflows = join(root, '.afk/workflows');
    await mkdir(workflows, { recursive: true });
    await writeFile(join(workflows, 'held-task.yml'), JSON.stringify({ name: 'held-task', version: 1,
      steps: [{ id: 'implement', role: 'implementer', executionMode: 'batch', prompt: 'Perform the local fixture task.' }] }));
    const display = Object.fromEntries(['DISPLAY', 'XAUTHORITY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS']
      .flatMap(key => process.env[key] ? [[key, process.env[key]!]] : []));
    const app = await electron.launch({ args: [desktop, '--use-mock-keychain', `--user-data-dir=${join(root, 'chromium')}`], cwd: root,
      env: { ...env, ...display, AFK_WORKSPACE: root, AFK_E2E_NO_WINDOW: '1', ELECTRON_RENDERER_URL: RENDERER_URL } });
    try {
      const page = await app.firstWindow();
      const start = await page.evaluate(input => window.afkDesktop.workItems.start(input), { workItemId, workflow: 'held-task',
        repositories: [{ platform: 'gitlab' as const, projectKey: `${host}/acme/api`, name: 'api', checkoutPath: 'repositories/api', baseBranch: 'main' }] });
      const system = join(root, '.afk/workspaces', createHash('sha256').update(start.workspace.root).digest('hex'));
      const runs = async () => JSON.parse(await readFile(join(system, 'work-item-runs.json'), 'utf8'));
      const journal = async (id: string) => (await readFile(join(system, 'executions', `${id}.jsonl`), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      const launches = async () => (await text('launches')).trim().split('\n').map(Number);
      await expect.poll(async () => (await launches().catch(() => [])).length).toBe(1);
      const collision = await run('cli-contender').then(() => ({ code: 0, stderr: '' }), error => ({ code: error.code, stderr: error.stderr }));
      expect(collision).toMatchObject({ code: 1, stderr: expect.stringContaining('repository is leased by another execution') });
      expect(await launches()).toHaveLength(1);
      expect(await runs()).toMatchObject([{ id: start.runId, status: 'running' }]);
      await writeFile(join(root, 'release'), 'fail first attempt');
      await expect.poll(async () => (await runs())[0].status).toBe('failed');
      const failed = await journal(start.runId);
      expect(failed.at(-1)).toMatchObject({ workItemId, phase: 'failed', reason: expect.stringContaining('agent process failed with exit code 1') });
      expect(labels).toEqual(expect.arrayContaining(['stage::blocked', 'mode::hitl']));
      expect(await launches()).toHaveLength(1);
      const retry = (reason: string) => cli('backlog', 'retry', '--id', '1', '--project', `${host}/acme/api`, '--platform', 'gitlab', '--reason', reason);
      await retry('Local agent recovered');
      const checkoutStatus = async () => (await execute('git', ['status', '--porcelain=v1', '--untracked-files=all', '--ignored=matching', '--ignore-submodules=none'], { cwd: checkout, env })).stdout;
      expect(await checkoutStatus()).toBe('');
      const userSettings = join(checkout, '.claude/settings.local.json');
      const contents = '{"language":"Spanish"}\n';
      await mkdir(join(checkout, '.claude'), { recursive: true });
      await writeFile(userSettings, contents, { flag: 'wx' });
      const dirtyStatus = await checkoutStatus();
      expect(dirtyStatus).toBe('?? .claude/settings.local.json\n');
      await expect(run('cli-dirty')).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('repository has uncommitted changes:') });
      expect(await launches()).toHaveLength(1);
      expect(await checkoutStatus()).toBe(dirtyStatus);
      expect(await readFile(userSettings, 'utf8')).toBe(contents);
      await rename(userSettings, join(root, 'preserved-user-settings.json'));
      const recoveryStatus = await checkoutStatus();
      expect(recoveryStatus).toBe('');
      await retry('User settings preserved outside the fixture checkout');
      const recovered = await run('cli-recovery');
      const completed = await journal('cli-recovery');
      expect(completed.at(-1)).toMatchObject({ workItemId, phase: 'merge_ready' });
      const pids = await launches();
      expect(pids).toHaveLength(4);
      expect(new Set(pids).size).toBe(4);
      expect(requests.filter(request => /^POST .*\/merge_requests$/.test(request))).toHaveLength(1);
      await expect(journal('cli-contender')).rejects.toMatchObject({ code: 'ENOENT' });
      await info.attach('claim-receipt', { contentType: 'application/json', body: JSON.stringify({ workItemId, start, desktop: await runs(),
        collision, dirtyStatus, recoveryStatus, failed, recovered: recovered.stdout, completed, pids, labels }, null, 2) });
    } finally {
      await writeFile(join(root, 'release'), 'release on cleanup');
      await app.close();
    }
  });
});
