import { Command } from 'commander';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseWorkItemId } from '@afk/runtime/domain/work-item/identity';
import type { LearningCandidate, LearningJob, LearningState } from '@afk/runtime/execution';
import { registerExperienceCommands, type ExperienceCommandComposition } from './experience.js';

const runtime = vi.hoisted(() => ({
  ExperienceStore: vi.fn(),
  experienceStorePath: vi.fn(() => '/tmp/afk-experience-command-test.sqlite'),
  experienceScope: vi.fn(),
  verifyExperienceRun: vi.fn(),
  verifyAdoptionRun: vi.fn(),
  learningDirectory: vi.fn(() => '/tmp/afk-learning-command-test'),
  queryLearningState: vi.fn(),
  createCliPluginRuntime: vi.fn(),
}));
vi.mock('@afk/runtime/execution', async importOriginal => ({
  ...await importOriginal<typeof import('@afk/runtime/execution')>(), ...runtime,
}));
vi.mock('../composition-root.js', () => ({ createCliPluginRuntime: runtime.createCliPluginRuntime }));

const scope = 'gitlab:git.example.test/team/project';
const workItemId = `${scope}#42`;
const directories: string[] = [];
const candidate = {
  id: 'experience-42', scope, status: 'candidate', trigger: 'test failed', rootCause: 'missing input validation',
  action: 'validate input before writing', source: { runId: 'failed-run', workItemId }, evidence: ['evidence://failed-run/test'],
};

beforeEach(() => {
  runtime.experienceScope.mockImplementation((id: string) => {
    const parsed = parseWorkItemId(id);
    return `${parsed.platform}:${parsed.projectKey}`;
  });
  runtime.verifyExperienceRun.mockImplementation(async (input: { runId: string; evidence: string[] }) => [...input.evidence, `run:${input.runId}#qa.passed`]);
  runtime.verifyAdoptionRun.mockResolvedValue(undefined);
});
afterEach(() => {
  vi.restoreAllMocks(); vi.clearAllMocks();
  for (const root of directories.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const records = [structuredClone(candidate)];
  const store = {
    recordFailure: vi.fn((input: Omit<typeof candidate, 'id' | 'status'>) => {
      const record = { ...input, id: 'recorded-experience', status: 'candidate' };
      records.push(record);
      return record;
    }),
    list: vi.fn((options: { scope: string; status?: string; limit?: number }) => records
      .filter(record => record.scope === options.scope && (!options.status || record.status === options.status))
      .slice(0, options.limit)),
    get: vi.fn((id: string, scope: string) => records.find(record => record.id === id && record.scope === scope)),
    recall: vi.fn(() => [{ ...candidate, status: 'verified' }]),
    verify: vi.fn((id: string, input: { evidence: string[]; runId: string; action?: string }) => {
      const record = records.find(record => record.id === id)!;
      Object.assign(record, { ...input, status: 'verified' });
      return record;
    }),
    revoke: vi.fn((id: string) => {
      const record = records.find(record => record.id === id)!;
      record.status = 'revoked';
      return record;
    }),
    export: vi.fn(() => JSON.stringify({ version: 1, scope, experiences: [] })),
    import: vi.fn(() => [candidate]),
    copy: vi.fn(() => ({ ...candidate, scope: 'github:acme/target' })),
    metrics: vi.fn(() => ({ retrievals: 3, adoptions: 1, recurrences: 2 })),
    adopt: vi.fn(() => ({ retrievals: 3, adoptions: 2, recurrences: 2 })),
    close: vi.fn(),
  };
  runtime.ExperienceStore.mockImplementation(() => store);
  const createStore = vi.fn(() => store);
  const output: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation(chunk => { output.push(String(chunk)); return true; });
  const program = new Command().name('afk').exitOverride().configureOutput({ writeErr: () => {} });
  registerExperienceCommands(program, { createStore: createStore as unknown as ExperienceCommandComposition['createStore'], verifyRun: runtime.verifyExperienceRun });
  return { store, records, createStore, program, output,
    parse: (...args: string[]) => program.parseAsync(['node', 'afk', 'experience', ...args]),
    printed: () => output.join(''),
  };
}

function learningFixture(composition: ExperienceCommandComposition = {}) {
  const job: LearningJob = { jobId: 'a'.repeat(64), scope, sourceId: 'run:42', sourceRunId: 'source-run', workItemId,
    status: 'blocked', reasonCode: 'budget_exhausted', attempts: [] };
  const proposal: LearningCandidate = { id: 'b'.repeat(64), requestKey: job.jobId, version: 1, state: 'candidate',
    digest: 'c'.repeat(64), evidenceDigest: 'd'.repeat(64), proposal: {
      kind: 'fact', title: 'Input validation', statement: 'Validate before writing', evidenceIds: ['audit-1'],
      applicability: { project: scope, environments: [], versions: [], preconditions: [], exclusions: [], invalidationConditions: [] },
      payload: { subject: 'input', rule: 'Validate', classification: 'proposal' },
    } };
  const state: LearningState = { jobs: [job], candidates: [proposal] };
  const query = vi.fn(() => state);
  const output: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation(chunk => { output.push(String(chunk)); return true; });
  const program = new Command().name('afk').exitOverride().configureOutput({ writeErr: () => {} });
  registerExperienceCommands(program, { queryLearningState: query, ...composition });
  return { state, job, proposal, query, program, output,
    parse: (...args: string[]) => program.parseAsync(['node', 'afk', 'experience', ...args]),
    printed: () => output.join(''),
  };
}

describe('read-only learning governance', () => {
  it.each([
    { command: ['prepare', 'b'.repeat(64), '--expected-version', '2', '--target', 'wiki:retry'],
      action: 'prepare', input: { scope, candidateId: 'b'.repeat(64), expectedVersion: 2, targetRef: 'wiki:retry' },
      result: { key: 'e'.repeat(64), phase: 'prepared' } },
    { command: ['publish', 'e'.repeat(64)], action: 'publish', input: { scope, key: 'e'.repeat(64) },
      result: { publication: { key: 'e'.repeat(64), phase: 'committed' } } },
    { command: ['reconcile'], action: 'reconcile', input: { scope }, result: { results: [], blocked: [] } },
  ])('dispatches scoped knowledge $action without legacy storage or disposing borrowed runtimes', async current => {
    const plugins = { dispatchSystemAction: vi.fn().mockResolvedValue(current.result), dispose: vi.fn() };
    const test = learningFixture({ pluginRuntime: plugins as unknown as NonNullable<ExperienceCommandComposition['pluginRuntime']> });
    await test.parse('knowledge', ...current.command, '--scope', scope, '--json');
    expect(plugins.dispatchSystemAction).toHaveBeenCalledOnce();
    expect(plugins.dispatchSystemAction).toHaveBeenCalledWith(`learning.knowledge.${current.action}`, current.input);
    expect(JSON.parse(test.printed())).toEqual(current.result);
    expect(plugins.dispose).not.toHaveBeenCalled();
    expect(runtime.ExperienceStore).not.toHaveBeenCalled();
    expect(test.query).not.toHaveBeenCalled();
  });

  it.each(['dispatch', 'dispose', 'startup'] as const)('sanitizes knowledge %s failures and releases its owned runtime', async failure => {
    const error = new Error('PRIVATE_TRANSCRIPT credential=PRIVATE_TOKEN');
    const plugins = { dispatchSystemAction: vi.fn().mockResolvedValue({ results: [], blocked: [] }), dispose: vi.fn().mockResolvedValue(undefined) };
    if (failure === 'dispatch') plugins.dispatchSystemAction.mockRejectedValue(error);
    if (failure === 'dispose') plugins.dispose.mockRejectedValue(error);
    runtime.createCliPluginRuntime.mockResolvedValue(plugins);
    if (failure === 'startup') runtime.createCliPluginRuntime.mockRejectedValue(error);
    const test = learningFixture();
    await expect(test.parse('knowledge', 'reconcile', '--scope', scope)).rejects.toThrow(/^Learning knowledge operation failed$/);
    expect(plugins.dispose).toHaveBeenCalledTimes(failure === 'startup' ? 0 : 1);
    expect(test.printed()).not.toContain('PRIVATE_');
  });

  it.each([
    ['prepare', 'invalid', '--expected-version', '2', '--scope', scope],
    ['prepare', 'b'.repeat(64), '--expected-version', '0', '--scope', scope],
    ['publish', 'e'.repeat(64), '--scope', 'other-project'],
  ])('rejects invalid knowledge input before creating a runtime: %s', async (...args) => {
    const test = learningFixture();
    await expect(test.parse('knowledge', ...args)).rejects.toThrow();
    expect(runtime.createCliPluginRuntime).not.toHaveBeenCalled();
  });

  it.each([
    { command: ['publish', 'e'.repeat(64)], result: { publication: { phase: 'conflict' }, withdrawal: { status: 'withdrawn' } }, code: 1 },
    { command: ['reconcile'], result: { results: [], blocked: [{ key: 'e'.repeat(64), code: 'publication_recovery_blocked' }] }, code: 1 },
    { command: ['reconcile'], result: { results: [{ publication: { phase: 'conflict' }, withdrawal: { status: 'rollback_blocked' } }], blocked: [] }, code: 1 },
    { command: ['reconcile'], result: { results: [{ publication: { phase: 'conflict' }, withdrawal: { status: 'withdrawn' } }], blocked: [] }, code: 0 },
  ])('reports actual knowledge outcome with exit status $code', async current => {
    const previousExitCode = process.exitCode;
    process.exitCode = 0;
    try {
      const dispatchSystemAction = vi.fn().mockResolvedValue(current.result);
      const test = learningFixture({ pluginRuntime: { dispatchSystemAction } as unknown as NonNullable<ExperienceCommandComposition['pluginRuntime']> });
      await test.parse('knowledge', ...current.command, '--scope', scope, '--json');
      expect(JSON.parse(test.printed())).toEqual(current.result);
      expect(process.exitCode).toBe(current.code);
    } finally { process.exitCode = previousExitCode; }
  });

  it('validates a candidate through the shared plugin action without opening the legacy store', async () => {
    const result = { status: 'validated', candidateId: 'b'.repeat(64), candidateVersion: 1, validatedVersion: 2,
      executionId: 'validation-execution', receiptDigest: 'e'.repeat(64) };
    const dispatchSystemAction = vi.fn().mockResolvedValue(result);
    const test = learningFixture({ pluginRuntime: { dispatchSystemAction } as unknown as NonNullable<ExperienceCommandComposition['pluginRuntime']> });
    await test.parse('validate', test.proposal.id, '--scope', scope, '--expected-version', '1', '--checker', 'approval-rules', '--json');
    expect(dispatchSystemAction).toHaveBeenCalledWith('learning.validate', { scope, candidateId: test.proposal.id,
      expectedVersion: 1, checkerId: 'approval-rules' });
    expect(JSON.parse(test.printed())).toEqual(result);
    expect(runtime.ExperienceStore).not.toHaveBeenCalled();
    expect(test.query).not.toHaveBeenCalled();
  });

  it('returns a blocked validation result with a nonzero exit status', async () => {
    const previousExitCode = process.exitCode;
    try {
      const result = { status: 'blocked', code: 'checker_unavailable' };
      const dispatchSystemAction = vi.fn().mockResolvedValue(result);
      const test = learningFixture({ pluginRuntime: { dispatchSystemAction } as unknown as NonNullable<ExperienceCommandComposition['pluginRuntime']> });
      await test.parse('validate', test.proposal.id, '--scope', scope, '--expected-version', '1', '--checker', 'approval-rules', '--json');
      expect(JSON.parse(test.printed())).toEqual(result);
      expect(process.exitCode).toBe(1);
    } finally { process.exitCode = previousExitCode; }
  });

  it.each(['injected', 'factory'] as const)('does not dispose a borrowed %s runtime', async source => {
    const plugins = { dispatchSystemAction: vi.fn().mockResolvedValue({ status: 'validated', validatedVersion: 2 }), dispose: vi.fn() };
    const createRuntime = vi.fn().mockResolvedValue(plugins);
    const test = learningFixture(source === 'injected'
      ? { pluginRuntime: plugins as unknown as NonNullable<ExperienceCommandComposition['pluginRuntime']> }
      : { createRuntime });
    await test.parse('validate', test.proposal.id, '--scope', scope, '--expected-version', '1', '--checker', 'approval-rules');
    expect(plugins.dispose).not.toHaveBeenCalled();
    expect(createRuntime).toHaveBeenCalledTimes(source === 'factory' ? 1 : 0);
    expect(runtime.createCliPluginRuntime).not.toHaveBeenCalled();
  });

  it.each(['dispatch', 'dispose', 'startup'] as const)('sanitizes %s errors and releases only an owned runtime', async failure => {
    const error = new Error('PRIVATE_TRANSCRIPT credential=PRIVATE_TOKEN');
    const plugins = { dispatchSystemAction: vi.fn().mockResolvedValue({ status: 'validated', validatedVersion: 2 }),
      dispose: vi.fn().mockResolvedValue(undefined) };
    if (failure === 'dispatch') plugins.dispatchSystemAction.mockRejectedValue(error);
    if (failure === 'dispose') plugins.dispose.mockRejectedValue(error);
    runtime.createCliPluginRuntime.mockResolvedValue(plugins);
    if (failure === 'startup') runtime.createCliPluginRuntime.mockRejectedValue(error);
    const test = learningFixture();
    expect(runtime.createCliPluginRuntime).not.toHaveBeenCalled();
    await expect(test.parse('validate', test.proposal.id, '--scope', scope, '--expected-version', '1', '--checker', 'approval-rules'))
      .rejects.toThrow(/^Learning validation failed$/);
    expect(plugins.dispose).toHaveBeenCalledTimes(failure === 'startup' ? 0 : 1);
    expect(test.printed()).not.toContain('PRIVATE_');
  });

  it('lazily creates and releases the default runtime for a successful validation', async () => {
    const plugins = { dispatchSystemAction: vi.fn().mockResolvedValue({ status: 'validated', validatedVersion: 2 }),
      dispose: vi.fn().mockResolvedValue(undefined) };
    runtime.createCliPluginRuntime.mockResolvedValue(plugins);
    const test = learningFixture();
    expect(runtime.createCliPluginRuntime).not.toHaveBeenCalled();
    await test.parse('validate', test.proposal.id, '--scope', scope, '--expected-version', '1', '--checker', 'approval-rules');
    expect(runtime.createCliPluginRuntime).toHaveBeenCalledOnce();
    expect(plugins.dispose).toHaveBeenCalledOnce();
  });

  it.each(['0', '-1', '1.5', '9007199254740992'])('rejects invalid validation version %s before selecting a runtime', async version => {
    const dispatchSystemAction = vi.fn();
    const test = learningFixture({ pluginRuntime: { dispatchSystemAction } as unknown as NonNullable<ExperienceCommandComposition['pluginRuntime']> });
    await expect(test.parse('validate', test.proposal.id, '--scope', scope, '--expected-version', version, '--checker', 'approval-rules')).rejects.toThrow();
    expect(dispatchSystemAction).not.toHaveBeenCalled();
  });

  it.each(['jobs', 'candidates'])('returns existing %s DTOs without opening the experience store', async command => {
    const test = learningFixture();
    await test.parse(command, '--scope', scope, '--json');
    expect(JSON.parse(test.printed())).toEqual(test.state[command as keyof LearningState]);
    expect(test.query).toHaveBeenCalledWith({ directory: '/tmp/afk-learning-command-test', scope });
    expect(runtime.ExperienceStore).not.toHaveBeenCalled();
  });

  it.each(['jobs', 'candidates', 'inspect'])('prefers the existing plugin action for %s', async command => {
    const dispatchSystemAction = vi.fn();
    const pluginRuntime = { dispatchSystemAction } as unknown as NonNullable<ExperienceCommandComposition['pluginRuntime']>;
    const test = learningFixture({ pluginRuntime });
    dispatchSystemAction.mockResolvedValue(command === 'jobs' ? test.state.jobs : test.state.candidates);
    await test.parse(command, ...(command === 'inspect' ? [test.proposal.id] : []), '--scope', scope, '--json');
    expect(dispatchSystemAction).toHaveBeenCalledOnce();
    expect(dispatchSystemAction).toHaveBeenCalledWith(`learning.${command === 'jobs' ? 'jobs' : 'candidates'}`, { scope });
    expect(test.query).not.toHaveBeenCalled();
    expect(runtime.learningDirectory).not.toHaveBeenCalled();
    expect(JSON.parse(test.printed())).toEqual(command === 'inspect' ? test.proposal : test.state[command as keyof LearningState]);
  });

  it.each(['jobs', 'candidates'])('filters %s to the exact scope before sorting and pagination', async command => {
    const test = learningFixture();
    const foreignScope = `${scope}-foreign`;
    test.state.jobs = [{ ...test.job, jobId: '0'.repeat(64), scope: foreignScope },
      { ...test.job, jobId: 'f'.repeat(64) }, test.job, { ...test.job, jobId: '1'.repeat(64) }];
    test.state.candidates = [{ ...test.proposal, id: '0'.repeat(64), proposal: { ...test.proposal.proposal,
      applicability: { ...test.proposal.proposal.applicability, project: foreignScope } } },
    { ...test.proposal, id: 'f'.repeat(64) }, test.proposal, { ...test.proposal, id: '1'.repeat(64) }];
    const original = structuredClone(test.state);
    await test.parse(command, '--scope', scope, '--limit', '1', '--offset', '1', '--json');
    expect(JSON.parse(test.printed())).toEqual([command === 'jobs' ? test.job : test.proposal]);
    expect(test.state).toEqual(original);
  });

  it.each(['jobs', 'candidates'])('bounds %s pages at 100 and supports zero and safe-integer offsets', async command => {
    const test = learningFixture();
    test.state.jobs = Array.from({ length: 102 }, (_, index) => ({ ...test.job, jobId: index.toString(16).padStart(64, '0') })).reverse();
    test.state.candidates = Array.from({ length: 102 }, (_, index) => ({ ...test.proposal, id: index.toString(16).padStart(64, '0') })).reverse();
    await test.parse(command, '--scope', scope, '--json');
    expect(JSON.parse(test.printed())).toHaveLength(100);
    test.output.length = 0;
    await test.parse(command, '--scope', scope, '--limit', '100', '--offset', '100', '--json');
    expect(JSON.parse(test.printed())).toEqual(test.state[command as keyof LearningState].slice(0, 2).reverse());
    test.output.length = 0;
    await test.parse(command, '--scope', scope, '--limit', '0', '--offset', '0', '--json');
    expect(JSON.parse(test.printed())).toEqual([]);
    test.output.length = 0;
    await test.parse(command, '--scope', scope, '--limit', '100', '--offset', String(Number.MAX_SAFE_INTEGER), '--json');
    expect(JSON.parse(test.printed())).toEqual([]);
  });

  it.each(['jobs', 'candidates', 'inspect'])('requires an exact canonical scope for %s before querying', async command => {
    const test = learningFixture();
    const args = command === 'inspect' ? [test.proposal.id] : [];
    await expect(test.parse(command, ...args)).rejects.toMatchObject({ code: 'commander.missingMandatoryOptionValue' });
    for (const invalid of ['acme/project', 'github:acme/project#42', ' github:acme/project', 'github:acme/project ', 'github:acme/project\n']) {
      await expect(test.parse(command, ...args, '--scope', invalid)).rejects.toMatchObject({ code: 'commander.invalidArgument' });
    }
    expect(test.query).not.toHaveBeenCalled();
  });

  it.each(['jobs', 'candidates'])('rejects malformed %s pagination before querying', async command => {
    const test = learningFixture();
    for (const flag of ['--limit', '--offset']) {
      for (const invalid of ['-1', '1.5', '1e2', '0x10', 'NaN', 'Infinity', '', ' 1', '1\n', '9007199254740992']) {
        await expect(test.parse(command, '--scope', scope, flag, invalid)).rejects.toMatchObject({ code: 'commander.invalidArgument' });
      }
    }
    await expect(test.parse(command, '--scope', scope, '--limit', '101')).rejects.toMatchObject({ code: 'commander.invalidArgument' });
    expect(test.query).not.toHaveBeenCalled();
  });

  it.each(['', 'a'.repeat(63), 'a'.repeat(65), 'g'.repeat(64), 'A'.repeat(64), ` ${'a'.repeat(64)}`, `${'a'.repeat(64)}\n`, '../candidate'])
    ('rejects noncanonical candidate IDs: %j', async id => {
      const test = learningFixture();
      await expect(test.parse('inspect', id, '--scope', scope)).rejects.toMatchObject({ code: 'commander.invalidArgument' });
      expect(test.query).not.toHaveBeenCalled();
    });

  it('inspects the complete existing DTO and refuses absent or foreign candidates identically', async () => {
    const test = learningFixture();
    await test.parse('inspect', test.proposal.id, '--scope', scope, '--json');
    expect(JSON.parse(test.printed())).toEqual(test.proposal);
    test.output.length = 0;
    await expect(test.parse('inspect', 'e'.repeat(64), '--scope', scope)).rejects.toThrow('Candidate not found in scope');
    test.proposal.proposal.applicability.project = `${scope}-foreign`;
    await expect(test.parse('inspect', test.proposal.id, '--scope', scope)).rejects.toThrow('Candidate not found in scope');
    expect(test.printed()).toBe('');
  });

  it.each([true, false])('preserves storage-blocked diagnostics in jobs (json=%s)', async json => {
    const test = learningFixture();
    test.job.reasonCode = 'storage_blocked';
    test.job.attempts = [{ requestKey: test.job.jobId, callId: 'storage-call', day: '2026-11-10',
      startedAt: '2026-11-10T00:00:00Z', ownerPid: 42, host: 'local-host', status: 'failed', errorCode: 'storage_blocked' }];
    await test.parse('jobs', '--scope', scope, ...(json ? ['--json'] : []));
    if (json) expect(JSON.parse(test.printed())).toEqual([test.job]);
    else expect(test.printed()).toBe(`${test.job.jobId} [blocked] storage_blocked\n`);
  });

  it('prints only compact identities, statuses and safe stage codes', async () => {
    const test = learningFixture();
    test.job.sourceId = 'SENSITIVE_TRANSCRIPT';
    test.proposal.proposal.statement = 'SENSITIVE_TRANSCRIPT';
    await test.parse('jobs', '--scope', scope);
    await test.parse('candidates', '--scope', scope);
    await test.parse('inspect', test.proposal.id, '--scope', scope);
    expect(test.printed()).toBe(`${test.job.jobId} [blocked] budget_exhausted\n${test.proposal.id} [candidate]\n${test.proposal.id} [candidate]\n`);
    test.output.length = 0;
    test.job.reasonCode = 'authorization: Bearer PRIVATE_TOKEN\nRAW_TRANSCRIPT';
    await test.parse('jobs', '--scope', scope);
    expect(test.printed()).toBe(`${test.job.jobId} [blocked]\n`);
  });

  it.each(['jobs', 'candidates', 'inspect'])('emits only existing %s DTO fields, never pack or credential extensions', async command => {
    const test = learningFixture();
    const expected = structuredClone(command === 'jobs' ? test.state.jobs : command === 'inspect' ? test.proposal : test.state.candidates);
    Object.assign(test.job, { pack: { content: 'PRIVATE_PACK_BODY' }, credentials: 'PRIVATE_TOKEN' });
    Object.assign(test.proposal, { pack: { content: 'PRIVATE_PACK_BODY' }, credentials: 'PRIVATE_TOKEN' });
    await test.parse(command, ...(command === 'inspect' ? [test.proposal.id] : []), '--scope', scope, '--json');
    expect(JSON.parse(test.printed())).toEqual(expected);
    expect(test.printed()).not.toMatch(/PRIVATE_PACK_BODY|PRIVATE_TOKEN/);
  });

  it('omits free-form blocked reasons from JSON instead of dumping sensitive transcripts', async () => {
    const test = learningFixture();
    test.job.reasonCode = 'RAW_TRANSCRIPT authorization: Bearer PRIVATE_TOKEN';
    await test.parse('jobs', '--scope', scope, '--json');
    const { reasonCode, ...expected } = test.job;
    expect(JSON.parse(test.printed())).toEqual([expected]);
    expect(test.printed()).not.toContain('PRIVATE_TOKEN');
  });

  it('preserves existing attempt identities, usage and safe errors while excluding extension fields', async () => {
    const test = learningFixture();
    const attempt = { requestKey: test.job.jobId, callId: 'analysis-call', day: '2026-11-10', startedAt: '2026-11-10T00:00:00Z',
      ownerPid: 42, host: 'local-host', status: 'failed' as const, analysisRunId: 'analysis-run', sessionId: 'analysis-session',
      finishedAt: '2026-11-10T00:00:01Z', errorCode: 'analysis_failed', usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 } };
    const pending = { requestKey: test.job.jobId, callId: 'pending-call', day: attempt.day, startedAt: attempt.startedAt,
      ownerPid: 42, host: 'local-host', status: 'started' as const };
    test.job.attempts = [structuredClone(attempt), pending];
    Object.assign(test.job.attempts[0], { transcript: 'PRIVATE_TRANSCRIPT' });
    Object.assign(test.job.attempts[0].usage!, { credentials: 'PRIVATE_TOKEN' });
    await test.parse('jobs', '--scope', scope, '--json');
    expect(JSON.parse(test.printed())[0].attempts).toEqual([attempt, pending]);
    expect(test.printed()).not.toMatch(/PRIVATE_TRANSCRIPT|PRIVATE_TOKEN/);
  });

  it('fails closed on invalid job status or candidate proposal without dumping the DTO', async () => {
    const test = learningFixture();
    Object.assign(test.job, { status: 'PRIVATE_TRANSCRIPT' });
    await expect(test.parse('jobs', '--scope', scope, '--json')).rejects.toThrow(/^Learning query failed$/);
    Object.assign(test.proposal.proposal, { credentials: 'PRIVATE_TOKEN' });
    await expect(test.parse('candidates', '--scope', scope, '--json')).rejects.toThrow(/^Learning query failed$/);
    expect(test.printed()).toBe('');
  });

  it('does not manufacture fallback data when the injected runtime has no learning action', async () => {
    const { PluginRuntime } = await import('@afk/runtime/plugin-sdk');
    const pluginRuntime = new PluginRuntime();
    try {
      const test = learningFixture({ pluginRuntime });
      await expect(test.parse('jobs', '--scope', scope, '--json')).rejects.toThrow(/^Learning query failed$/);
      expect(test.query).not.toHaveBeenCalled();
      expect(test.printed()).toBe('');
    } finally { await pluginRuntime.dispose(); }
  });

  it.each(['jobs', 'candidates', 'inspect'])('never dumps query errors or falls back after a failed plugin %s action', async command => {
    const dispatchSystemAction = vi.fn().mockRejectedValue(new Error('RAW_TRANSCRIPT credential=PRIVATE_TOKEN'));
    const test = learningFixture({ pluginRuntime: { dispatchSystemAction } as unknown as ExperienceCommandComposition['pluginRuntime'] });
    await expect(test.parse(command, ...(command === 'inspect' ? [test.proposal.id] : []), '--scope', scope, '--json'))
      .rejects.toThrow(/^Learning query failed$/);
    expect(test.query).not.toHaveBeenCalled();
    expect(test.printed()).toBe('');
  });

  it('sanitizes fallback errors without retaining the raw error as a cause', async () => {
    const test = learningFixture();
    test.query.mockImplementation(() => { throw new Error('RAW_TRANSCRIPT credential=PRIVATE_TOKEN'); });
    const error = await test.parse('jobs', '--scope', scope, '--json').catch(error => error);
    expect(error.message).toBe('Learning query failed');
    expect(error.cause).toBeUndefined();
    expect(test.printed()).toBe('');
  });

  it('uses the real runtime query on a missing ledger without creating directories, ledgers or workers', async () => {
    const actual = await vi.importActual<typeof import('@afk/runtime/execution')>('@afk/runtime/execution');
    const root = mkdtempSync(join(realpathSync(tmpdir()), 'learning-cli-'));
    directories.push(root);
    const directory = join(root, 'missing-learning');
    runtime.learningDirectory.mockReturnValueOnce(directory).mockReturnValueOnce(directory).mockReturnValueOnce(directory);
    runtime.queryLearningState.mockImplementation(actual.queryLearningState);
    const worker = vi.spyOn(actual.LearningWorker.prototype, 'runOnce');
    const test = learningFixture({ queryLearningState: undefined });
    await test.parse('jobs', '--scope', scope, '--json');
    expect(JSON.parse(test.printed())).toEqual([]);
    test.output.length = 0;
    await test.parse('candidates', '--scope', scope, '--json');
    expect(JSON.parse(test.printed())).toEqual([]);
    await expect(test.parse('inspect', test.proposal.id, '--scope', scope)).rejects.toThrow('Candidate not found in scope');
    expect(existsSync(directory)).toBe(false);
    expect(runtime.queryLearningState).toHaveBeenCalledTimes(3);
    expect(runtime.ExperienceStore).not.toHaveBeenCalled();
    expect(worker).not.toHaveBeenCalled();
  });

  it('reads a real submitted job without exposing its evidence pack or creating a worker queue', async () => {
    const actual = await vi.importActual<typeof import('@afk/runtime/execution')>('@afk/runtime/execution');
    const root = mkdtempSync(join(realpathSync(tmpdir()), 'learning-cli-'));
    directories.push(root);
    const file = join(root, 'evidence.txt');
    writeFileSync(file, 'PRIVATE_EVIDENCE_PACK_BODY');
    const pack = await actual.buildEvidencePack({ sources: [{ id: 'source-1', kind: 'journal', path: file, allowedRoot: root, format: 'text' }] });
    const directory = join(root, 'learning');
    await actual.submitDistillation({ directory, pack, request: { version: 1, scope, sourceId: 'run:42', evidenceDigest: pack.digest,
      analyzerVersion: '1', reason: 'completed' } });
    const before = readFileSync(join(directory, 'candidates.sqlite'));
    const test = learningFixture({ queryLearningState: input => actual.queryLearningState({ ...input, directory }) });
    await test.parse('jobs', '--scope', scope, '--json');
    expect(JSON.parse(test.printed())).toEqual(actual.queryLearningState({ directory, scope }).jobs);
    expect(test.printed()).not.toContain('PRIVATE_EVIDENCE_PACK_BODY');
    expect(readFileSync(join(directory, 'candidates.sqlite'))).toEqual(before);
    expect(existsSync(join(directory, 'distillation-queue.sqlite'))).toBe(false);
  });
});

describe('experience governance commands', () => {
  it('runs portable export to stdout or a new file and never overwrites an existing file', async () => {
    const test = fixture();
    await test.parse('export', '--scope', scope, '--limit', '10');
    expect(test.store.export).toHaveBeenCalledWith({ scope, limit: 10 });
    expect(JSON.parse(test.printed())).toEqual({ version: 1, scope, experiences: [] });
    const root = mkdtempSync(join(tmpdir(), 'experience-cli-'));
    directories.push(root);
    const file = join(root, 'lessons.json');
    await test.parse('export', '--scope', scope, '--output', file);
    expect(readFileSync(file, 'utf8')).toBe(`${test.store.export()}\n`);
    await expect(test.parse('export', '--scope', scope, '--output', file)).rejects.toMatchObject({ code: 'EEXIST' });
    expect(test.store.close).toHaveBeenCalledTimes(3);
  });

  it('reads bounded UTF-8 JSON for candidate import into an explicit target scope', async () => {
    const test = fixture();
    const root = mkdtempSync(join(tmpdir(), 'experience-cli-'));
    directories.push(root);
    const file = join(root, 'lessons.json');
    const json = test.store.export();
    writeFileSync(file, json);
    await test.parse('import', '--scope', scope, '--file', file);
    expect(test.store.import).toHaveBeenCalledWith({ scope, json });
    expect(JSON.parse(test.printed())).toEqual([candidate]);
    expect(test.store.close).toHaveBeenCalledOnce();
  });

  it('rejects oversized, non-file, missing, and invalid UTF-8 input before opening the store', async () => {
    const test = fixture();
    const root = mkdtempSync(join(tmpdir(), 'experience-cli-'));
    directories.push(root);
    const file = join(root, 'lessons.json');
    await expect(test.parse('import', '--scope', scope, '--file', root)).rejects.toThrow('regular JSON file');
    await expect(test.parse('import', '--scope', scope, '--file', file)).rejects.toMatchObject({ code: 'ENOENT' });
    writeFileSync(file, ' '.repeat(1024 * 1024 + 1));
    await expect(test.parse('import', '--scope', scope, '--file', file)).rejects.toThrow('1048576');
    writeFileSync(file, Buffer.from([0xff]));
    await expect(test.parse('import', '--scope', scope, '--file', file)).rejects.toThrow();
    expect(test.createStore).not.toHaveBeenCalled();
  });

  it('runs explicit cross-project copying and distinguishes metrics from adoption', async () => {
    const test = fixture();
    const targetScope = 'github:acme/target';
    await test.parse('copy', candidate.id, '--scope', scope, '--target-scope', targetScope);
    expect(test.store.copy).toHaveBeenCalledWith({ id: candidate.id, scope, targetScope });
    await test.parse('metrics', '--scope', scope, '--json');
    expect(test.store.metrics).toHaveBeenCalledWith({ scope });
    await test.parse('adopt', candidate.id, '--scope', scope, '--run-id', 'using-run', '--work-item-id', workItemId);
    expect(test.store.adopt).toHaveBeenCalledWith({ id: candidate.id, scope, source: { runId: 'using-run', workItemId } });
    expect(runtime.verifyAdoptionRun).toHaveBeenCalledWith({ scope, runId: 'using-run', workItemId });
    expect(test.store.close).toHaveBeenCalledTimes(3);
  });

  it('awaits the exact-task audit guard before counting an explicit acknowledgement', async () => {
    const test = fixture();
    let finish!: () => void;
    runtime.verifyAdoptionRun.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
    const pending = test.parse('adopt', candidate.id, '--scope', scope, '--run-id', 'using-run', '--work-item-id', workItemId, '--root', '/tmp/adoption-events');
    expect(runtime.verifyAdoptionRun).toHaveBeenCalledWith({ scope, runId: 'using-run', workItemId, root: '/tmp/adoption-events' });
    expect(test.store.adopt).not.toHaveBeenCalled();
    expect(test.store.close).not.toHaveBeenCalled();
    finish();
    await pending;
    expect(test.store.adopt).toHaveBeenCalledOnce();
    expect(test.store.close).toHaveBeenCalledOnce();
  });

  it.each(['missing run', 'wrong work item', 'foreign scope', 'corrupt run'])('does not count an acknowledgement when the audit guard rejects: %s', async reason => {
    const test = fixture();
    runtime.verifyAdoptionRun.mockRejectedValue(new Error(reason));
    await expect(test.parse('adopt', candidate.id, '--scope', scope, '--run-id', 'claimed-run', '--work-item-id', workItemId)).rejects.toThrow(reason);
    expect(test.store.adopt).not.toHaveBeenCalled();
    expect(test.store.close).toHaveBeenCalledOnce();
    expect(test.printed()).toBe('');
  });

  it.each(['export', 'import', 'copy', 'metrics', 'adopt'])('provides actionable help for %s', command => {
    const test = fixture();
    const group = test.program.commands.find(entry => entry.name() === 'experience')!;
    const help = group.commands.find(entry => entry.name() === command)!.helpInformation();
    expect(help).toContain('--scope <project>');
    expect(help).toContain('--help');
    expect(test.createStore).not.toHaveBeenCalled();
  });

  it('lists only scoped records and passes status and numeric limit to the store', async () => {
    const test = fixture();
    await test.parse('list', '--scope', scope, '--status', 'candidate', '--limit', '3', '--json');
    expect(test.store.list).toHaveBeenCalledWith({ scope, status: 'candidate', limit: 3 });
    expect(JSON.parse(test.printed())).toEqual([candidate]);
    expect(test.store.close).toHaveBeenCalledOnce();
  });

  it('prints a readable inventory when JSON is not requested', async () => {
    const test = fixture();
    await test.parse('list', '--scope', scope);
    expect(test.printed()).toContain(candidate.id);
    expect(test.printed()).toContain('candidate');
    expect(test.printed()).toContain(candidate.trigger);
    expect(test.store.close).toHaveBeenCalledOnce();
  });

  it('never includes records from another scope in list output', async () => {
    const test = fixture();
    test.store.list.mockReturnValue([candidate, { ...candidate, id: 'foreign', scope: 'github:private/foreign', trigger: 'FOREIGN_CONTENT_SENTINEL' }]);
    await test.parse('list', '--scope', scope, '--json');
    expect(JSON.parse(test.printed())).toEqual([candidate]);
    expect(test.printed()).not.toContain('FOREIGN_CONTENT_SENTINEL');
    expect(test.store.close).toHaveBeenCalledOnce();
  });

  it('recalls using an explicit project scope and query', async () => {
    const test = fixture();
    await test.parse('recall', '--scope', scope, '--query', 'input validation');
    expect(test.store.recall).toHaveBeenCalledWith({ scope, prompt: 'input validation' });
    expect(test.printed()).toContain(candidate.id);
    expect(test.printed()).toContain('verified');
    expect(test.printed()).toContain(candidate.action);
    expect(test.store.close).toHaveBeenCalledOnce();
  });

  it('records a manual candidate with canonical work identity and all evidence references', async () => {
    const test = fixture();
    await test.parse('record', '--scope', scope, '--trigger', candidate.trigger, '--root-cause', candidate.rootCause,
      '--action', candidate.action, '--run-id', candidate.source.runId, '--work-item-id', workItemId,
      '--evidence', 'evidence://failure', 'evidence://logs');
    expect(test.store.recordFailure).toHaveBeenCalledWith({ scope, trigger: candidate.trigger, rootCause: candidate.rootCause,
      action: candidate.action, source: candidate.source, evidence: ['evidence://failure', 'evidence://logs'] });
    expect(test.records.at(-1)).toMatchObject({ status: 'candidate', source: candidate.source, scope });
    expect(test.printed()).toBe('Recorded candidate recorded-experience\n');
    expect(test.store.close).toHaveBeenCalledOnce();
  });

  it.each(['github:other/project#42', '42', `${scope}#042`])('rejects foreign or noncanonical record identity %s before opening the store', async identity => {
    const test = fixture();
    await expect(test.parse('record', '--scope', scope, '--trigger', 'failure', '--root-cause', 'cause', '--action', 'fix',
      '--run-id', 'run', '--work-item-id', identity, '--evidence', 'evidence://failure')).rejects.toThrow();
    expect(test.createStore).not.toHaveBeenCalled();
    expect(test.store.recordFailure).not.toHaveBeenCalled();
    expect(test.printed()).toBe('');
  });

  it('verifies only a record found in the explicit scope and applies correction evidence', async () => {
    const test = fixture();
    await test.parse('verify', candidate.id, '--scope', scope, '--run-id', 'successful-run', '--action', 'check before write',
      '--evidence', 'evidence://successful-test', 'evidence://review');
    expect(test.store.get).toHaveBeenCalledWith(candidate.id, scope);
    expect(runtime.verifyExperienceRun).toHaveBeenCalledWith({ scope, runId: 'successful-run', evidence: ['evidence://successful-test', 'evidence://review'] });
    expect(test.store.verify).toHaveBeenCalledWith(candidate.id, { runId: 'successful-run', action: 'check before write', evidence: ['evidence://successful-test', 'evidence://review', 'run:successful-run#qa.passed'] });
    expect(test.records[0]).toMatchObject({ status: 'verified', action: 'check before write' });
    expect(test.printed()).toBe(`Verified experience ${candidate.id}\n`);
    expect(test.store.close).toHaveBeenCalledOnce();
  });

  it('can verify a scoped record outside the bounded list and forward a corrected root cause', async () => {
    const test = fixture();
    test.store.list.mockReturnValue([]);
    await test.parse('verify', candidate.id, '--scope', scope, '--run-id', 'successful-run', '--action', 'fix',
      '--root-cause', 'corrected cause', '--evidence', 'evidence://qa');
    expect(test.store.get).toHaveBeenCalledWith(candidate.id, scope);
    expect(test.store.list).not.toHaveBeenCalled();
    expect(test.store.verify).toHaveBeenCalledWith(candidate.id, { runId: 'successful-run', action: 'fix', rootCause: 'corrected cause', evidence: ['evidence://qa', 'run:successful-run#qa.passed'] });
    expect(test.store.close).toHaveBeenCalledOnce();
  });

  it('revokes a record only after checking its scope', async () => {
    const test = fixture();
    await test.parse('revoke', candidate.id, '--scope', scope);
    expect(test.store.get).toHaveBeenCalledWith(candidate.id, scope);
    expect(test.store.revoke).toHaveBeenCalledWith(candidate.id);
    expect(test.records[0].status).toBe('revoked');
    expect(test.printed()).toBe(`Revoked experience ${candidate.id}\n`);
    expect(test.store.close).toHaveBeenCalledOnce();
  });

  it.each(['verify', 'revoke'])('%s never mutates or reveals a foreign record even when lookup returns it', async command => {
    const test = fixture();
    test.store.get.mockReturnValue({ ...candidate, scope: 'github:private/foreign', trigger: 'FOREIGN_CONTENT_SENTINEL' });
    const args = command === 'verify' ? ['--run-id', 'run', '--action', 'fix', '--evidence', 'evidence://test'] : [];
    await expect(test.parse(command, candidate.id, '--scope', scope, ...args)).rejects.toThrow('Experience not found in scope');
    expect(test.store.verify).not.toHaveBeenCalled();
    expect(test.store.revoke).not.toHaveBeenCalled();
    expect(runtime.verifyExperienceRun).not.toHaveBeenCalled();
    expect(test.printed()).toBe('');
    expect(test.store.close).toHaveBeenCalledOnce();
  });

  it.each(['verify', 'revoke'])('%s uses the same safe error for a missing record', async command => {
    const test = fixture();
    const args = command === 'verify' ? ['--run-id', 'run', '--action', 'fix', '--evidence', 'evidence://test'] : [];
    await expect(test.parse(command, 'missing', '--scope', scope, ...args)).rejects.toThrow('Experience not found in scope');
    expect(test.store.verify).not.toHaveBeenCalled();
    expect(test.store.revoke).not.toHaveBeenCalled();
    expect(test.printed()).toBe('');
    expect(test.store.close).toHaveBeenCalledOnce();
  });

  it('does not inspect run evidence or mutate when the scoped lookup fails', async () => {
    const test = fixture();
    const failure = new Error('scoped lookup unavailable');
    test.store.get.mockImplementation(() => { throw failure; });
    await expect(test.parse('verify', candidate.id, '--scope', scope, '--run-id', 'successful-run', '--action', 'fix', '--evidence', 'evidence://qa')).rejects.toBe(failure);
    expect(runtime.verifyExperienceRun).not.toHaveBeenCalled();
    expect(test.store.verify).not.toHaveBeenCalled();
    expect(test.store.close).toHaveBeenCalledOnce();
    expect(test.printed()).toBe('');
  });

  it.each([
    ['list'], ['recall', '--scope', scope], ['verify', candidate.id, '--scope', scope], ['revoke', candidate.id],
    ['record', '--scope', scope],
  ].map(args => ({ args })))('requires governance arguments before opening the store: $args', async ({ args }) => {
    const test = fixture();
    await expect(test.parse(...args)).rejects.toMatchObject({ code: 'commander.missingMandatoryOptionValue' });
    expect(test.createStore).not.toHaveBeenCalled();
  });

  it.each(['team/project', 'github:team/project#42', 'gitlab:', 'unknown:team/project'])('rejects invalid scope %s before opening the store', async invalid => {
    const test = fixture();
    await expect(test.parse('list', '--scope', invalid)).rejects.toMatchObject({ code: 'commander.invalidArgument' });
    expect(test.createStore).not.toHaveBeenCalled();
  });

  it.each(['-1', '1.5', '3items', '101', 'Infinity', '9007199254740992'])('rejects invalid limit %s before opening the store', async limit => {
    const test = fixture();
    await expect(test.parse('list', '--scope', scope, '--limit', limit)).rejects.toMatchObject({ code: 'commander.invalidArgument' });
    expect(test.createStore).not.toHaveBeenCalled();
  });

  it('rejects unknown status values before opening the store', async () => {
    const test = fixture();
    await expect(test.parse('list', '--scope', scope, '--status', 'untrusted')).rejects.toMatchObject({ code: 'commander.invalidArgument' });
    expect(test.createStore).not.toHaveBeenCalled();
  });

  it.each(['', '   ', '\0'])('rejects blank or invalid correction %j before opening the store', async action => {
    const test = fixture();
    await expect(test.parse('verify', candidate.id, '--scope', scope, '--run-id', 'run', '--action', action, '--evidence', 'evidence://test')).rejects.toMatchObject({ code: 'commander.invalidArgument' });
    expect(test.createStore).not.toHaveBeenCalled();
  });

  it('rejects empty evidence references before opening the store', async () => {
    const test = fixture();
    await expect(test.parse('verify', candidate.id, '--scope', scope, '--run-id', 'run', '--action', 'fix', '--evidence', '   ')).rejects.toMatchObject({ code: 'commander.invalidArgument' });
    expect(test.createStore).not.toHaveBeenCalled();
  });

  it.each(['list', 'recall', 'record', 'verify', 'revoke'])('closes the store when %s fails and propagates the error to the CLI boundary', async command => {
    const test = fixture();
    const failure = new Error('experience store unavailable');
    const method = command === 'record' ? test.store.recordFailure : test.store[command as 'list' | 'recall' | 'verify' | 'revoke'];
    method.mockImplementation(() => { throw failure; });
    const args = command === 'list' ? [] : command === 'recall' ? ['--query', 'validation'] : command === 'revoke' ? [candidate.id] :
      command === 'verify' ? [candidate.id, '--run-id', 'run', '--action', 'fix', '--evidence', 'evidence://test'] :
        ['--trigger', 'failure', '--root-cause', 'cause', '--action', 'fix', '--run-id', 'run', '--work-item-id', workItemId, '--evidence', 'evidence://failure'];
    await expect(test.parse(command, '--scope', scope, ...args)).rejects.toBe(failure);
    expect(test.store.close).toHaveBeenCalledOnce();
    expect(test.printed()).toBe('');
  });

  it('uses the runtime store path when no factory is injected', async () => {
    const test = fixture();
    const program = new Command().exitOverride();
    registerExperienceCommands(program);
    await program.parseAsync(['node', 'afk', 'experience', 'list', '--scope', scope, '--json']);
    expect(runtime.experienceStorePath).toHaveBeenCalledOnce();
    expect(runtime.ExperienceStore).toHaveBeenCalledWith({ file: '/tmp/afk-experience-command-test.sqlite' });
    expect(JSON.parse(test.printed())).toEqual([candidate]);
    expect(test.store.close).toHaveBeenCalledOnce();
  });

  it('uses the runtime QA guard when no verification override is injected', async () => {
    const test = fixture();
    const program = new Command().exitOverride();
    registerExperienceCommands(program, { createStore: test.createStore as unknown as ExperienceCommandComposition['createStore'] });
    await program.parseAsync(['node', 'afk', 'experience', 'verify', candidate.id, '--scope', scope, '--run-id', 'successful-run', '--action', 'fix', '--evidence', 'evidence://qa']);
    expect(runtime.verifyExperienceRun).toHaveBeenCalledWith({ scope, runId: 'successful-run', evidence: ['evidence://qa'] });
    expect(test.store.verify).toHaveBeenCalledWith(candidate.id, { runId: 'successful-run', action: 'fix', evidence: ['evidence://qa', 'run:successful-run#qa.passed'] });
    expect(test.store.close).toHaveBeenCalledOnce();
  });

  it('awaits the QA guard before mutation and closes only after verification completes', async () => {
    const test = fixture();
    let finish!: (evidence: string[]) => void;
    runtime.verifyExperienceRun.mockImplementation(() => new Promise<string[]>(resolve => { finish = resolve; }));
    const pending = test.parse('verify', candidate.id, '--scope', scope, '--run-id', 'successful-run', '--action', 'fix', '--root', '/tmp/test-events', '--evidence', 'evidence://qa');
    expect(runtime.verifyExperienceRun).toHaveBeenCalledWith({ scope, runId: 'successful-run', evidence: ['evidence://qa'], root: '/tmp/test-events' });
    expect(test.store.verify).not.toHaveBeenCalled();
    expect(test.store.close).not.toHaveBeenCalled();
    finish(['evidence://qa', 'run:successful-run#qa.passed']);
    await pending;
    expect(test.store.verify).toHaveBeenCalledWith(candidate.id, { runId: 'successful-run', action: 'fix', evidence: ['evidence://qa', 'run:successful-run#qa.passed'] });
    expect(test.store.close).toHaveBeenCalledOnce();
  });

  it.each(['invalid integrity', 'foreign work item', 'QA failed', 'QA missing'])('denies verification when run evidence fails: %s', async reason => {
    const test = fixture();
    const failure = new Error(reason);
    runtime.verifyExperienceRun.mockRejectedValue(failure);
    await expect(test.parse('verify', candidate.id, '--scope', scope, '--run-id', 'claimed-success', '--action', 'fix', '--evidence', 'claimed-reference')).rejects.toBe(failure);
    expect(test.store.verify).not.toHaveBeenCalled();
    expect(test.records[0].status).toBe('candidate');
    expect(test.store.close).toHaveBeenCalledOnce();
    expect(test.printed()).toBe('');
  });

  it('returns recalled records as JSON and excludes any foreign scope', async () => {
    const test = fixture();
    const verified = { ...candidate, status: 'verified' };
    test.store.recall.mockReturnValue([verified, { ...verified, scope: 'github:private/foreign', trigger: 'FOREIGN_CONTENT_SENTINEL' }]);
    await test.parse('recall', '--scope', scope, '--query', 'validation', '--json');
    expect(JSON.parse(test.printed())).toEqual([verified]);
    expect(test.printed()).not.toContain('FOREIGN_CONTENT_SENTINEL');
    expect(test.store.close).toHaveBeenCalledOnce();
  });

  it('accepts the service list bounds including zero results', async () => {
    const test = fixture();
    await test.parse('list', '--scope', scope, '--limit', '0', '--json');
    expect(JSON.parse(test.printed())).toEqual([]);
    expect(test.store.list).toHaveBeenCalledWith({ scope, limit: 0, status: undefined });
    expect(test.store.close).toHaveBeenCalledOnce();
  });
});
