import { Command } from 'commander';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseWorkItemId } from '@afk/runtime/domain/work-item/identity';
import { registerExperienceCommands, type ExperienceCommandComposition } from './experience.js';

const runtime = vi.hoisted(() => ({
  ExperienceStore: vi.fn(),
  experienceStorePath: vi.fn(() => '/tmp/afk-experience-command-test.sqlite'),
  experienceScope: vi.fn(),
  verifyExperienceRun: vi.fn(),
  verifyAdoptionRun: vi.fn(),
}));
vi.mock('@afk/runtime/execution', () => runtime);

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
