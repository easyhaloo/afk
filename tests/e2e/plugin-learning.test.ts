import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vitest';

const execute = promisify(execFile);
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });

it('records a failed simulated agent, verifies evidence through the CLI, and supplies then revokes experience in later engine runs', async () => {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'plugin-learning-e2e-')));
  roots.push(root);
  const home = join(root, 'home');
  const bin = join(root, 'bin');
  await Promise.all([fs.mkdir(home), fs.mkdir(bin)]);
  const transport = await fs.readFile(resolve('tests/fixtures/plugin-matrix/execution/transport.mjs'), 'utf8');
  await fs.writeFile(join(bin, 'claude'), `#!${process.execPath}\n${transport}`, { mode: 0o755 });
  const runtime = resolve('packages/runtime/dist');
  const env = { HOME: home, USERPROFILE: home, PATH: [bin, '/usr/bin', '/bin'].join(delimiter),
    MATRIX_RUNTIME: runtime, AFK_EVENT_STORE_DIR: join(root, 'events'), AFK_LOG_DIR: join(root, 'logs'), NO_COLOR: '1' };
  const command = (...args: string[]) => execute(process.execPath, [resolve('apps/cli/dist/index.js'), ...args], { cwd: root, env, timeout: 15_000 });
  const cli = (...args: string[]) => command('experience', ...args);
  let sequence = 0;
  const run = async (mode: 'failure' | 'success') => {
    const workspace = join(root, `workspace-${sequence++}`);
    await fs.mkdir(join(workspace, '.afk', 'workflows'), { recursive: true });
    await execute('git', ['init', '--initial-branch=main'], { cwd: workspace, env });
    await fs.writeFile(join(workspace, '.gitignore'), '.afk/\nmatrix-agent.json\nmanaged-result.json\n');
    await execute('git', ['add', '.gitignore'], { cwd: workspace, env });
    await execute('git', ['-c', 'user.name=Learning Fixture', '-c', 'user.email=fixture@example.test', '-c', 'commit.gpgsign=false', 'commit', '-m', 'fixture'], { cwd: workspace, env });
    await fs.writeFile(join(workspace, '.afk', 'workflows', 'matrix.yml'), JSON.stringify({ name: 'matrix', version: 1,
      steps: [{ id: 'implement', kind: 'agent', role: 'implementer', prompt: 'Run the deterministic subprocess fixture' },
        { id: 'queue', kind: 'system', action: 'queue-qa', dependsOn: ['implement'] }] }));
    await fs.writeFile(join(root, 'agent-mode'), mode);
    await execute(process.execPath, [resolve('tests/fixtures/plugin-matrix/execution/managed-run.mjs'), 'claude-code', 'local', mode], { cwd: workspace, env, timeout: 25_000 });
    return { workspace, result: JSON.parse(await fs.readFile(join(workspace, 'managed-result.json'), 'utf8')) };
  };
  const first = await run('failure');
  expect(first.result.error ?? first.result.result?.success).not.toBe(true);
  expect(first.result.events.some((event: { kind: string }) => event.kind === 'failure.classified')).toBe(true);
  const candidates = JSON.parse((await cli('list', '--scope', 'github:matrix/repo', '--status', 'candidate', '--json')).stdout);
  const candidate = candidates.find((entry: { trigger: string }) => entry.trigger.includes('agent_'));
  expect(candidate).toBeDefined();
  expect(candidate.source.workItemId).toBe('github:matrix/repo#42');
  const empty = JSON.parse((await cli('recall', '--scope', candidate.scope, '--query', 'simulated agent matrix', '--json')).stdout);
  expect(empty).toEqual([]);
  await expect(cli('verify', candidate.id, '--scope', candidate.scope, '--run-id', 'missing-qa', '--action', 'Inspect deterministic subprocess exit status before retrying', '--evidence', 'evidence://missing')).rejects.toMatchObject({ code: 1 });

  const auditModule = pathToFileURL(join(runtime, 'infrastructure/observability/jsonl-event-store.js')).href;
  await execute(process.execPath, ['--input-type=module', '--eval', `
    import { JsonlEventStore } from ${JSON.stringify(auditModule)};
    const context = { traceId: 'qa-fixture', runId: 'qa-fixture', workItemId: 'github:matrix/repo#42', profileId: 'local-fixture', attempt: 1, actor: { kind: 'system', id: 'synthetic-qa' } };
    const data = [{ kind: 'qa.started' }, { kind: 'qa.passed' }, { kind: 'run.finished', outcome: 'succeeded' }];
    await new JsonlEventStore({ root: process.env.AFK_EVENT_STORE_DIR }).append(data.map((entry, index) => ({ id: 'qa-' + index, schemaVersion: 1, type: entry.kind, occurredAt: new Date().toISOString(), context, correlationId: context.runId, data: entry })));
  `], { env, timeout: 10_000 });
  await cli('verify', candidate.id, '--scope', candidate.scope, '--run-id', 'qa-fixture', '--action', 'Check deterministic subprocess exit status and use bounded retries', '--evidence', 'run:qa-fixture#regression');
  const verified = JSON.parse((await cli('recall', '--scope', candidate.scope, '--query', 'simulated agent matrix', '--json')).stdout);
  expect(verified.map((entry: { id: string }) => entry.id)).toContain(candidate.id);
  const second = await run('success');
  expect(second.result.error).toBeUndefined();
  expect(second.result.result.success).toBe(true);
  expect(second.result.effect.prompt || second.result.effect.argv.join(' ')).toContain('.afk/experience-context.md');
  expect(await fs.readFile(join(second.workspace, '.afk', 'experience-context.md'), 'utf8')).toContain('bounded retries');
  expect(second.result.events).toContainEqual(expect.objectContaining({ kind: 'decision.made', command: 'experience.recall', accepted: true }));
  await command('plugin', 'disable', 'context.experience');
  const disabled = await run('success');
  expect(disabled.result.result.success).toBe(true);
  expect(disabled.result.effect.prompt || disabled.result.effect.argv.join(' ')).not.toContain('.afk/experience-context.md');
  await expect(fs.readFile(join(disabled.workspace, '.afk', 'experience-context.md'))).rejects.toMatchObject({ code: 'ENOENT' });
  await command('plugin', 'enable', 'context.experience');
  const enabled = await run('success');
  expect(enabled.result.result.success).toBe(true);
  expect(enabled.result.effect.prompt || enabled.result.effect.argv.join(' ')).toContain('.afk/experience-context.md');
  await expect(cli('revoke', candidate.id, '--scope', 'github:other/repo')).rejects.toMatchObject({ code: 1 });
  await cli('revoke', candidate.id, '--scope', candidate.scope);
  const third = await run('success');
  expect(third.result.error).toBeUndefined();
  expect(third.result.result.success).toBe(true);
  expect(third.result.effect.prompt || third.result.effect.argv.join(' ')).not.toContain('.afk/experience-context.md');
  await expect(fs.readFile(join(third.workspace, '.afk', 'experience-context.md'))).rejects.toMatchObject({ code: 'ENOENT' });
}, 90_000);
