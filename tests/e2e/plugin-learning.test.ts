import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vitest';
import { JsonlEventStore, verifyRunEventHistory } from '../../packages/runtime/src/infrastructure/observability/jsonl-event-store.js';

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
  const runtime = resolve(process.env.AFK_E2E_RUNTIME_ROOT ?? 'packages/runtime/dist');
  const env = { HOME: home, USERPROFILE: home, PATH: [bin, '/usr/bin', '/bin'].join(delimiter), MATRIX_PERSIST_AUDIT: '1',
    MATRIX_RUNTIME: runtime, AFK_EVENT_STORE_DIR: join(root, 'events'), AFK_LOG_DIR: join(root, 'logs'), NO_COLOR: '1' };
  const command = (...args: string[]) => execute(process.execPath, [resolve(process.env.AFK_E2E_CLI_ENTRY ?? 'apps/cli/dist/index.js'), ...args], { cwd: root, env, timeout: 15_000 });
  const cli = (...args: string[]) => command('experience', ...args);
  let sequence = 0;
  const run = async (mode: 'failure' | 'success') => {
    const runId = `learning-engine-${sequence++}`;
    const workspace = join(root, runId);
    await fs.mkdir(join(workspace, '.afk', 'workflows'), { recursive: true });
    await execute('git', ['init', '--initial-branch=main'], { cwd: workspace, env });
    await fs.writeFile(join(workspace, '.gitignore'), '.afk/\nmatrix-agent.json\nmanaged-result.json\n');
    await execute('git', ['add', '.gitignore'], { cwd: workspace, env });
    await execute('git', ['-c', 'user.name=Learning Fixture', '-c', 'user.email=fixture@example.test', '-c', 'commit.gpgsign=false', 'commit', '-m', 'fixture'], { cwd: workspace, env });
    await fs.writeFile(join(workspace, '.afk', 'workflows', 'matrix.yml'), JSON.stringify({ name: 'matrix', version: 1,
      steps: [{ id: 'implement', kind: 'agent', role: 'implementer', prompt: 'Run the deterministic subprocess fixture' },
        { id: 'queue', kind: 'system', action: 'queue-qa', dependsOn: ['implement'] }] }));
    await fs.writeFile(join(root, 'agent-mode'), mode);
    await execute(process.execPath, [resolve('tests/fixtures/plugin-matrix/execution/managed-run.mjs'), 'claude-code', 'local', mode], {
      cwd: workspace, env: { ...env, MATRIX_RUN_ID: runId }, timeout: 25_000 });
    return { workspace, runId, result: JSON.parse(await fs.readFile(join(workspace, 'managed-result.json'), 'utf8')) };
  };
  const outcomes = async (runId: string, workItemId = 'github:matrix/repo#42') => JSON.parse((await cli('outcomes',
    '--scope', 'github:matrix/repo', '--run-id', runId, '--work-item-id', workItemId, '--json')).stdout);
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
  const verify = async (runId: string) => {
    await execute(process.execPath, ['--input-type=module', '--eval', `
    import { JsonlEventStore } from ${JSON.stringify(auditModule)};
    const context = { traceId: ${JSON.stringify(runId)}, runId: ${JSON.stringify(runId)}, workItemId: 'github:matrix/repo#42', profileId: 'local-fixture', attempt: 1, actor: { kind: 'system', id: 'synthetic-qa' } };
    const data = [{ kind: 'qa.started' }, { kind: 'qa.passed' }, { kind: 'run.finished', outcome: 'succeeded' }];
    await new JsonlEventStore({ root: process.env.AFK_EVENT_STORE_DIR }).append(data.map((entry, index) => ({ id: 'qa-' + index, schemaVersion: 1, type: entry.kind, occurredAt: new Date().toISOString(), context, correlationId: context.runId, data: entry })));
    `], { env, timeout: 10_000 });
    await cli('verify', candidate.id, '--scope', candidate.scope, '--run-id', runId, '--action', 'Check deterministic subprocess exit status and use bounded retries', '--evidence', `run:${runId}#regression`);
  };
  await verify('qa-fixture');
  const verified = JSON.parse((await cli('recall', '--scope', candidate.scope, '--query', 'simulated agent matrix', '--json')).stdout);
  expect(verified.map((entry: { id: string }) => entry.id)).toContain(candidate.id);
  const second = await run('success');
  expect(second.result.error).toBeUndefined();
  expect(second.result.result.success).toBe(true);
  expect(second.result.effect.prompt || second.result.effect.argv.join(' ')).toContain('.afk/experience-context.md');
  expect(await fs.readFile(join(second.workspace, '.afk', 'experience-context.md'), 'utf8')).toContain('bounded retries');
  expect(second.result.events).toContainEqual(expect.objectContaining({ kind: 'decision.made', command: 'experience.recall', accepted: true }));
  expect(await outcomes(second.runId)).toEqual([]);
  await command('plugin', 'disable', 'context.experience');
  const disabled = await run('success');
  expect(disabled.result.result.success).toBe(true);
  expect(disabled.result.effect.prompt || disabled.result.effect.argv.join(' ')).not.toContain('.afk/experience-context.md');
  await expect(fs.readFile(join(disabled.workspace, '.afk', 'experience-context.md'))).rejects.toMatchObject({ code: 'ENOENT' });
  await command('plugin', 'enable', 'context.experience');
  const enabled = await run('success');
  expect(enabled.result.result.success).toBe(true);
  expect(enabled.result.effect.prompt || enabled.result.effect.argv.join(' ')).toContain('.afk/experience-context.md');
  const recurring = await run('failure');
  expect(recurring.result.result?.success).not.toBe(true);
  expect(recurring.result.events.some((event: { kind: string }) => event.kind === 'failure.classified')).toBe(true);
  const receipts = await outcomes(recurring.runId);
  expect(receipts.length).toBeGreaterThan(0);
  expect(receipts).toContainEqual(expect.objectContaining({ selected: expect.objectContaining({ experienceId: candidate.id,
    source: { runId: recurring.runId, workItemId: candidate.source.workItemId } }), recurrence: true, benefit: 'unknown',
    event: expect.objectContaining({ type: 'failure.classified', outcome: 'failed' }) }));
  expect(receipts.filter((receipt: { recurrence: boolean }) => receipt.recurrence)).toHaveLength(1);
  const history = [];
  for await (const event of new JsonlEventStore({ root: env.AFK_EVENT_STORE_DIR }).read(recurring.runId)) history.push(event);
  expect(verifyRunEventHistory(recurring.runId, history).valid).toBe(true);
  for (const receipt of receipts) {
    const event = history.find(entry => entry.sequence === receipt.event.sequence)!;
    expect(event).toMatchObject({ context: { runId: recurring.runId, workItemId: candidate.source.workItemId },
      integrity: { hash: receipt.event.hash }, data: { kind: receipt.event.type } });
  }
  expect(await outcomes(recurring.runId, 'github:matrix/repo#99')).toEqual([]);
  expect(await outcomes(enabled.runId)).toEqual([]);
  const repeated = JSON.parse((await cli('list', '--scope', candidate.scope, '--status', 'candidate', '--json')).stdout);
  expect(repeated.find((entry: { id: string }) => entry.id === candidate.id)).toMatchObject({ status: 'candidate', occurrences: 2 });
  const metrics = JSON.parse((await cli('metrics', '--scope', candidate.scope, '--json')).stdout);
  expect(repeated).toContainEqual(expect.objectContaining({ trigger: 'workflow_crash', occurrences: 2 }));
  expect(metrics).toMatchObject({ adoptions: 0, recurrences: 2 });
  await command('plugin', 'disable', 'context.experience');
  expect(await outcomes(recurring.runId)).toEqual(receipts);
  const historyDisabled = await run('success');
  expect(historyDisabled.result.result.success).toBe(true);
  await expect(fs.readFile(join(historyDisabled.workspace, '.afk', 'experience-context.md'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await outcomes(recurring.runId)).toEqual(receipts);
  await command('plugin', 'enable', 'context.experience');
  await verify('qa-after-recurrence');
  const beforeRevoke = await run('success');
  expect(beforeRevoke.result.result.success).toBe(true);
  expect(await fs.readFile(join(beforeRevoke.workspace, '.afk', 'experience-context.md'), 'utf8')).toContain('bounded retries');
  await expect(cli('revoke', candidate.id, '--scope', 'github:other/repo')).rejects.toMatchObject({ code: 1 });
  await cli('revoke', candidate.id, '--scope', candidate.scope);
  const revoked = JSON.parse((await cli('list', '--scope', candidate.scope, '--status', 'revoked', '--json')).stdout);
  expect(revoked.map((entry: { id: string }) => entry.id)).toContain(candidate.id);
  expect(await outcomes(recurring.runId)).toEqual(receipts);
  const third = await run('success');
  expect(third.result.error).toBeUndefined();
  expect(third.result.result.success).toBe(true);
  expect(third.result.effect.prompt || third.result.effect.argv.join(' ')).not.toContain('.afk/experience-context.md');
  await expect(fs.readFile(join(third.workspace, '.afk', 'experience-context.md'))).rejects.toMatchObject({ code: 'ENOENT' });
  const calls = (await fs.readFile(join(root, 'transport.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  expect(calls).toHaveLength(sequence);
  expect(calls.every((call: { binary: string }) => call.binary === 'claude')).toBe(true);
}, 90_000);

it('binds synthetic active and QA-audited adoption receipts through the compiled CLI and rejects context and reverification conflicts without recounting', async () => {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'experience-adoption-e2e-')));
  roots.push(root);
  const home = join(root, 'home');
  await fs.mkdir(home);
  const runtime = resolve(process.env.AFK_E2E_RUNTIME_ROOT ?? 'packages/runtime/dist');
  const env = { HOME: home, USERPROFILE: home, PATH: process.env.PATH, NO_COLOR: '1',
    AFK_EVENT_STORE_DIR: join(root, 'events'), AFK_LOG_DIR: join(root, 'logs') };
  const executionModule = pathToFileURL(join(runtime, 'execution.js')).href;
  const auditModule = pathToFileURL(join(runtime, 'infrastructure/observability/jsonl-event-store.js')).href;
  const auditFixture = `
    import { randomUUID } from 'node:crypto';
    import { JsonlEventStore } from ${JSON.stringify(auditModule)};
    const scope = 'github:matrix/repo';
    const append = async (runId, data, workItemId = scope + '#99', actor = 'system') => {
      const context = { traceId: runId, runId, workItemId, profileId: 'local-fixture', attempt: 1,
        actor: { kind: actor, id: 'synthetic-adoption-fixture' } };
      await new JsonlEventStore({ root: process.env.AFK_EVENT_STORE_DIR }).append(data.map(entry => ({
        id: randomUUID(), schemaVersion: 1, type: entry.kind, occurredAt: new Date().toISOString(),
        context, correlationId: runId, data: entry,
      })));
    };
  `;
  const setup = await execute(process.execPath, ['--input-type=module', '--eval', `
    import { ExperienceStore, experienceStorePath, verifyApplicableExperience } from ${JSON.stringify(executionModule)};
    ${auditFixture}
    const required = { applicability: { environment: 'ci' }, target: { project: scope, dirty: false, productVersions: { sqlite: '3.45' } } };
    const target = { ...required, target: { ...required.target, revision: 'a'.repeat(40) } };
    const store = new ExperienceStore({ file: experienceStorePath() });
    const record = store.recordFailure({ scope, trigger: 'sqlite writer locked', rootCause: 'concurrent writes',
      action: 'Use bounded writer retries', source: { runId: 'failure', workItemId: scope + '#42' }, evidence: ['run:failure#failed'] });
    const unconstrained = store.recordFailure({ scope, trigger: 'input validation failed', rootCause: 'missing validation',
      action: 'Validate input before writing', source: { runId: 'input-failure', workItemId: scope + '#42' }, evidence: ['run:input-failure#failed'] });
    store.close();
    const successful = (snapshot, commit = snapshot.target.revision) => [
      { kind: 'qa.started' },
      { kind: 'decision.made', command: 'experience.qa-target', accepted: true, reason: JSON.stringify(snapshot) },
      { kind: 'commit.recorded', phase: 'qa', commitSha: commit, branch: 'qa-fixture' },
      { kind: 'qa.passed' }, { kind: 'run.finished', outcome: 'succeeded' },
    ];
    await append('proof', successful(target), scope + '#42');
    await verifyApplicableExperience({ id: record.id, scope, runId: 'proof', context: required, evidence: ['run:proof#regression'] });
    await append('proof-reverified', successful(target), scope + '#42');
    await append('active', [{ kind: 'run.started' }]);
    await append('active-target', successful({ ...target,
      target: { project: scope, dirty: false, revision: 'a'.repeat(40) } }).slice(0, 2));
    await append('unknown-product', successful(target).slice(0, 2));
    await append('agent-claim', successful(target), scope + '#99', 'agent');
    await append('wrong-commit', successful(target, 'b'.repeat(40)));
    await append('wrong-environment', successful({ ...target, applicability: { environment: 'production' } }));
    await append('dirty-target', successful({ ...target, target: { ...target.target, dirty: true } }));
    await append('compatible', successful({ ...target, target: { ...target.target, revision: 'b'.repeat(40) } }));
    await append('selected-before-reverification', successful(target));
    const consumer = new ExperienceStore({ file: experienceStorePath() });
    try {
      const retrieved = consumer.recordContextRetrieval({ id: record.id, scope,
        source: { runId: 'selected-before-reverification', workItemId: scope + '#99' },
        selectionId: randomUUID(), fragmentDigest: 'c'.repeat(64) }, target);
      consumer.recordContextSelection({ retrieved, fragmentDigest: retrieved.fragmentDigest });
    } finally { consumer.close(); }
    console.log(JSON.stringify({ id: record.id, unconstrainedId: unconstrained.id, scope }));
  `], { cwd: root, env, timeout: 15_000 });
  const record = JSON.parse(setup.stdout) as { id: string; unconstrainedId: string; scope: string };
  const cliEntry = resolve(process.env.AFK_E2E_CLI_ENTRY ?? 'apps/cli/dist/index.js');
  await execute(process.execPath, [cliEntry, 'experience', 'verify', record.unconstrainedId, '--scope', record.scope,
    '--run-id', 'proof', '--action', 'Validate input before writing', '--evidence', 'run:proof#input-regression'],
  { cwd: root, env, timeout: 15_000 });
  const acknowledge = (runId: string, id = record.id) => execute(process.execPath, [cliEntry, 'experience', 'adopt', id,
    '--scope', record.scope, '--run-id', runId, '--work-item-id', `${record.scope}#99`, '--root', env.AFK_EVENT_STORE_DIR],
  { cwd: root, env, timeout: 15_000 });
  const metrics = async () => JSON.parse((await execute(process.execPath,
    [cliEntry, 'experience', 'metrics', '--scope', record.scope, '--json'],
    { cwd: root, env, timeout: 15_000 })).stdout);
  for (const runId of ['active', 'active-target', 'agent-claim', 'wrong-commit', 'wrong-environment', 'dirty-target']) {
    await expect(acknowledge(runId)).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('applicability') });
  }
  await expect(acknowledge('unknown-product', record.unconstrainedId)).rejects.toMatchObject({ code: 1,
    stderr: expect.stringContaining('applicability') });
  expect((await metrics()).adoptions).toBe(0);
  await execute(process.execPath, ['--input-type=module', '--eval', `
    ${auditFixture}
    await append('unknown-product', [
      { kind: 'commit.recorded', phase: 'qa', commitSha: 'a'.repeat(40), branch: 'qa-fixture' },
      { kind: 'qa.passed' }, { kind: 'run.finished', outcome: 'succeeded' },
    ]);
  `], { cwd: root, env, timeout: 15_000 });
  await expect(acknowledge('unknown-product', record.unconstrainedId)).rejects.toMatchObject({ code: 1,
    stderr: expect.stringContaining('applicability') });
  expect((await metrics()).adoptions).toBe(0);
  const adoption = JSON.parse((await acknowledge('compatible')).stdout);
  expect(adoption).toEqual({ retrievals: 0, adoptions: 1, recurrences: 0, receipt: {
    binding: 'verified-version', experienceId: record.id, scope: record.scope,
    source: { runId: 'compatible', workItemId: `${record.scope}#99` }, version: 2,
    verificationDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
    contextDigest: expect.stringMatching(/^[a-f0-9]{64}$/), contextStatus: 'recorded', acknowledgedAt: expect.any(String),
  } });
  expect(new Date(adoption.receipt.acknowledgedAt).toISOString()).toBe(adoption.receipt.acknowledgedAt);
  expect(JSON.parse((await acknowledge('compatible')).stdout)).toEqual(adoption);
  const activeAdoption = JSON.parse((await acknowledge('active-target', record.unconstrainedId)).stdout);
  expect(activeAdoption).toMatchObject({ adoptions: 2, receipt: {
    binding: 'verified-version', experienceId: record.unconstrainedId, scope: record.scope,
    source: { runId: 'active-target', workItemId: `${record.scope}#99` }, contextStatus: 'recorded',
    contextDigest: createHash('sha256').update(JSON.stringify({ applicability: { environment: 'ci' },
      target: { dirty: false, project: record.scope, revision: 'a'.repeat(40) } })).digest('hex'),
  } });
  expect(JSON.parse((await acknowledge('active-target', record.unconstrainedId)).stdout)).toEqual(activeAdoption);
  const unavailable = JSON.parse((await acknowledge('active', record.unconstrainedId)).stdout);
  expect(unavailable).toMatchObject({ adoptions: 3, receipt: {
    binding: 'verified-version', contextStatus: 'unavailable', contextDigest: createHash('sha256').update('{}').digest('hex'),
  } });
  await execute(process.execPath, ['--input-type=module', '--eval', `
    import { verifyApplicableExperience } from ${JSON.stringify(executionModule)};
    ${auditFixture}
    await append('active-target', [{ kind: 'decision.made', command: 'experience.qa-target', accepted: true,
      reason: JSON.stringify({ applicability: { environment: 'ci' },
        target: { project: scope, dirty: false, revision: 'b'.repeat(40) } }) }]);
    await verifyApplicableExperience({ id: ${JSON.stringify(record.id)}, scope, runId: 'proof-reverified',
      context: { applicability: { environment: 'ci' }, target: { project: scope, dirty: false, productVersions: { sqlite: '3.45' } } },
      evidence: ['run:proof-reverified#regression'] });
  `], { cwd: root, env, timeout: 15_000 });
  await expect(acknowledge('active-target', record.unconstrainedId)).rejects.toMatchObject({ code: 1,
    stderr: expect.stringContaining('Adoption receipt binding conflicts') });
  await expect(acknowledge('compatible')).rejects.toMatchObject({ code: 1 });
  await expect(acknowledge('selected-before-reverification')).rejects.toMatchObject({ code: 1,
    stderr: expect.stringContaining('selected version') });
  expect((await metrics()).adoptions).toBe(3);
}, 90_000);
