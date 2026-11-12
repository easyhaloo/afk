import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { getEventListeners } from 'node:events';
import filesystem from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { prepareAssetProposal, verifyAssetProposal, type ProposalHarnessRequest, type ProposalInventory, type ProposalVerificationTask } from './proposals.js';
import { output } from './ledger-data.fixture.spec.js';
import { StaticScanVerificationProvider, TestRunnerVerificationProvider } from '../../infrastructure/verification/index.js';
import { LocalSandbox } from '../../infrastructure/sandbox/providers/local.js';
import { canonicalLearningJson } from './requests.js';
import type { ProviderOperationOptions } from '../../plugin-sdk/capabilities.js';

const digest = (content: string) => createHash('sha256').update(content).digest('hex');
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
function directory() {
  const root = mkdtempSync(join(tmpdir(), 'proposals-'));
  roots.push(root);
  return root;
}
const original = '---\nname: recover\ndescription: Recover interrupted jobs\ndisable-model-invocation: true\nallowed-tools: [Read]\ndisallowed-tools: [Bash]\n---\nOnly manual invocation. NEVER install dependencies.\n';
function inventory(): ProposalInventory {
  const root = directory();
  mkdirSync(join(root, 'recover'));
  writeFileSync(join(root, 'recover', 'SKILL.md'), original);
  return { skills: [{ name: 'recover', description: 'Recover interrupted jobs',
    'disable-model-invocation': true, 'user-invocable': true, 'allowed-tools': ['Read'], 'disallowed-tools': ['Bash'],
    source: { root, file: join(root, 'recover', 'SKILL.md') } }], tools: [], toolSearches: ['cli', 'script', 'plugin'] };
}
function skill() {
  return { ...output.candidates[0], kind: 'skill', title: 'Recover jobs', payload: {
    targetSkill: 'skill:recover', originalDigest: digest(original), triggers: ['Manual recovery request'],
    prohibitedConditions: ['No authorization'], inputs: [{ name: 'job', description: 'Job identifier', required: true }],
    branches: ['Resume an interrupted job'], recovery: ['Keep the original checkpoint'], completion: 'Checkpoint confirmed',
    patch: 'Parameterize the job identifier; require approval.', evaluationCases: [
      { kind: 'normal', input: 'job A', expected: 'Job A completed' },
      { kind: 'recovery', input: 'interrupted job B', expected: 'Job B resumes from checkpoint' },
      { kind: 'refusal', input: 'unauthorized job C', expected: 'Refuse without changing job C' },
    ],
  } };
}
function tool() {
  return { ...output.candidates[0], kind: 'tool', title: 'Checkpoint formatter', payload: {
    existingTools: [], inputSchema: { type: 'object', properties: { job: { type: 'string', pattern: '^[a-z]+$' } }, required: ['job'], additionalProperties: false },
    outputSchema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false },
    dependencies: [], permissions: [], timeoutMs: 500, sideEffects: 'none', idempotency: 'Pure formatting', recovery: 'Retry with the same input',
    source: 'throw new Error("Never execute during preparation");', tests: [
      { kind: 'normal', input: '{"job":"alpha"}', expected: '{"ok":true}' },
      { kind: 'normal', input: '{"job":"beta"}', expected: '{"ok":true}' },
      { kind: 'refusal', input: '{"job":"$(touch /tmp/pwned)"}', expected: 'Reject input without side effects' },
    ],
  } };
}

describe('bounded asset source reads', () => {
  afterEach(() => { vi.restoreAllMocks(); syncBuiltinESMExports(); });

  function sourceFixture(content: string | Buffer = 'module.exports = true;') {
    const catalog = inventory();
    const root = filesystem.realpathSync(catalog.skills[0].source.root);
    const parent = join(root, 'assets');
    mkdirSync(parent);
    const file = join(parent, 'adapter.js');
    writeFileSync(file, content);
    catalog.tools.push({ kind: 'script', ref: 'script:bounded', name: 'bounded', description: 'Checkpoint formatter',
      provenance: 'fixture', source: { root, file } });
    const candidate = tool();
    return { root, parent, file, prepare: () => prepareAssetProposal({ ...candidate, targetRef: 'script:bounded',
      payload: { ...candidate.payload, existingTools: ['script:bounded'] } }, catalog) };
  }

  function observeReads(file: string, beforeOpen?: () => void) {
    const nativeOpen = filesystem.openSync;
    const opened: number[] = [];
    const open = vi.spyOn(filesystem, 'openSync').mockImplementation((...parameters: Parameters<typeof filesystem.openSync>) => {
      const tracked = String(parameters[0]) === file;
      if (tracked) beforeOpen?.();
      const descriptor = nativeOpen(...parameters);
      if (tracked) opened.push(descriptor);
      return descriptor;
    });
    const read = vi.spyOn(filesystem, 'readSync');
    const close = vi.spyOn(filesystem, 'closeSync');
    syncBuiltinESMExports();
    return { open, read, close, opened, assertClosed: () => {
      for (const descriptor of opened) expect(close.mock.calls.filter(([closed]) => closed === descriptor)).toHaveLength(1);
    } };
  }

  it.each(['growth', 'symlink'] as const)('rejects %s after the final path stat', kind => {
    const current = sourceFixture();
    const outside = join(directory(), 'sentinel.txt');
    writeFileSync(outside, 'owned outside-root sentinel');
    const nativeStat = filesystem.statSync;
    let observations = 0;
    let changed = false;
    vi.spyOn(filesystem, 'statSync').mockImplementation((...parameters: Parameters<typeof filesystem.statSync>) => {
      const result = Reflect.apply(nativeStat, filesystem, parameters);
      if (String(parameters[0]) === current.file && ++observations === 2) {
        if (kind === 'growth') writeFileSync(current.file, 'x'.repeat(1024 * 1024));
        else { filesystem.unlinkSync(current.file); symlinkSync(outside, current.file); }
        changed = true;
      }
      return result;
    });
    syncBuiltinESMExports();
    expect(current.prepare).toThrow();
    expect(changed).toBe(true);
  });

  it('bounds same-FD reads when the observed source grows after fstat', () => {
    const current = sourceFixture();
    const size = filesystem.statSync(current.file).size;
    const observed = observeReads(current.file);
    const nativeStat = filesystem.fstatSync;
    let changed = false;
    vi.spyOn(filesystem, 'fstatSync').mockImplementation((...parameters: Parameters<typeof filesystem.fstatSync>) => {
      const result = Reflect.apply(nativeStat, filesystem, parameters);
      if (observed.opened.includes(parameters[0]) && !changed) {
        writeFileSync(current.file, 'x'.repeat(1024 * 1024));
        changed = true;
      }
      return result;
    });
    syncBuiltinESMExports();
    expect(current.prepare).toThrow();
    expect(changed).toBe(true);
    expect(observed.read.mock.calls.every(([, buffer]) => buffer.byteLength <= 65537)).toBe(true);
    expect(observed.read.mock.results.reduce((total, result) => total + (result.type === 'return' ? Number(result.value) : 0), 0)).toBeLessThanOrEqual(size + 1);
    observed.assertClosed();
  });

  it('refuses a leaf symlink at open before reading outside-root bytes', () => {
    const current = sourceFixture();
    const outside = join(directory(), 'sentinel.txt');
    writeFileSync(outside, 'owned outside-root sentinel');
    const observed = observeReads(current.file, () => { filesystem.unlinkSync(current.file); symlinkSync(outside, current.file); });
    expect(current.prepare).toThrow();
    expect(observed.read).not.toHaveBeenCalled();
    const flags = Number(observed.open.mock.calls.find(([file]) => String(file) === current.file)?.[1]);
    expect(flags & filesystem.constants.O_NOFOLLOW).toBe(filesystem.constants.O_NOFOLLOW);
    expect(flags & filesystem.constants.O_NONBLOCK).toBe(filesystem.constants.O_NONBLOCK);
    observed.assertClosed();
  });

  it.each(['root', 'parent'] as const)('rechecks %s identity before reading even when the replacement exposes the same inode', kind => {
    const current = sourceFixture();
    const outside = filesystem.realpathSync(directory());
    mkdirSync(join(outside, 'assets'));
    filesystem.linkSync(current.file, join(outside, 'assets', 'adapter.js'));
    const target = kind === 'root' ? current.root : current.parent;
    const displaced = `${target}-displaced`;
    if (kind === 'root') roots.push(displaced);
    const observed = observeReads(current.file, () => {
      filesystem.renameSync(target, displaced);
      symlinkSync(kind === 'root' ? outside : join(outside, 'assets'), target);
    });
    expect(current.prepare).toThrow();
    expect(observed.read).not.toHaveBeenCalled();
    expect(observed.opened).toHaveLength(1);
    observed.assertClosed();
  });

  it.each([null, undefined])('closes the asset FD and preserves thrown read failure %s', failure => {
    const current = sourceFixture();
    const observed = observeReads(current.file);
    observed.read.mockImplementation(() => { throw failure; });
    let threw = false;
    let caught: unknown;
    try { current.prepare(); } catch (error) { threw = true; caught = error; }
    expect(threw).toBe(true);
    expect(caught).toBe(failure);
    expect(observed.opened).toHaveLength(1);
    observed.assertClosed();
  });

  it('preserves valid multibyte UTF-8 at exactly 64KiB with bounded reads', () => {
    const content = 'λ'.repeat(32768);
    const current = sourceFixture(content);
    const observed = observeReads(current.file);
    expect(current.prepare().artifact.originalDigest).toBe(digest(content));
    expect(observed.opened).toHaveLength(1);
    expect(observed.read.mock.calls.length).toBeGreaterThan(1);
    expect(observed.read.mock.calls.every(([, buffer]) => buffer.byteLength <= 65537)).toBe(true);
    observed.assertClosed();
  });

  it('rejects invalid UTF-8 and still closes its source descriptor', () => {
    const current = sourceFixture(Buffer.from([0xc3, 0x28]));
    const observed = observeReads(current.file);
    expect(current.prepare).toThrow(/UTF-8/);
    expect(observed.opened).toHaveLength(1);
    observed.assertClosed();
  });
});

describe('controlled asset preparation', () => {
  it('binds a patch to catalog bytes and keeps manual invocation and tool restrictions', () => {
    const catalog = inventory();
    const prepared = prepareAssetProposal(skill(), catalog);
    expect(prepared.status).toBe('verification-prepared');
    expect(prepared.effectiveness).toBe('not-run');
    expect(prepared.artifact.originalDigest).toBe(digest(original));
    expect(prepared.artifact.content.startsWith(original)).toBe(true);
    expect(prepared.invocation).toMatchObject({ automatic: false, allowedTools: ['Read'], disallowedTools: ['Bash'] });
    expect(prepared.checks.map(check => check.kind)).toEqual(['normal', 'recovery', 'refusal']);
    expect(prepared.artifact.content).toContain('job');
    expect(readFileSync(catalog.skills[0].source.file, 'utf8')).toBe(original);
  });

  it('rejects stale digests, unknown targets and a new skill duplicating an existing catalog entry', () => {
    const catalog = inventory();
    const stale = skill();
    stale.payload.originalDigest = 'a'.repeat(64);
    expect(() => prepareAssetProposal(stale, catalog)).toThrow(/digest/i);
    const missing = skill();
    missing.payload.targetSkill = 'skill:missing';
    expect(() => prepareAssetProposal(missing, catalog)).toThrow(/catalog|existing/i);
    const duplicate = skill();
    const { targetSkill: _target, originalDigest: _original, ...payload } = duplicate.payload;
    expect(() => prepareAssetProposal({ ...duplicate, payload: { ...payload, newReason: 'Another recovery skill' } }, catalog)).toThrow(/existing|patch/i);
  });

  it('rejects reused behavior inputs and incomplete generalization', () => {
    const candidate = skill();
    candidate.payload.evaluationCases[1].input = candidate.payload.evaluationCases[0].input;
    expect(() => prepareAssetProposal(candidate, inventory())).toThrow(/independent|distinct/i);
    candidate.payload.evaluationCases[1].input = 'Interrupted B';
    candidate.payload.recovery = [];
    expect(() => prepareAssetProposal(candidate, inventory())).toThrow(/recovery/i);
  });

  it('reads restrictions from original source even when catalog metadata has drifted', () => {
    const catalog = inventory();
    catalog.skills[0]['disable-model-invocation'] = false;
    catalog.skills[0]['allowed-tools'] = ['Bash'];
    expect(prepareAssetProposal(skill(), catalog).invocation).toMatchObject({ automatic: false, allowedTools: ['Read'], disallowedTools: ['Bash'] });
  });

  it('refuses symlink escapes and catalog sources larger than the existing catalog limit', () => {
    const catalog = inventory();
    const outside = directory();
    writeFileSync(join(outside, 'outside.md'), original);
    const file = join(catalog.skills[0].source.root, 'outside.md');
    symlinkSync(join(outside, 'outside.md'), file);
    catalog.skills[0].source.file = file;
    expect(() => prepareAssetProposal(skill(), catalog)).toThrow(/escape/i);
    catalog.skills[0].source.file = join(catalog.skills[0].source.root, 'recover', 'SKILL.md');
    writeFileSync(catalog.skills[0].source.file, 'a'.repeat(65537));
    expect(() => prepareAssetProposal(skill(), catalog)).toThrow(/limit/i);
  });

  it('keeps the proposed skill within the same catalog byte limit', () => {
    const catalog = inventory();
    const source = original.padEnd(65530, ' ');
    writeFileSync(catalog.skills[0].source.file, source);
    const candidate = skill();
    candidate.payload.originalDigest = digest(source);
    expect(() => prepareAssetProposal(candidate, catalog)).toThrow(/limit/i);
  });

  it('prepares schemas, two parameters and failure checks without executing source or granting installation', () => {
    const prepared = prepareAssetProposal(tool(), inventory());
    expect(prepared.artifact.content).toBe(tool().payload.source);
    expect(prepared.checks.map(check => check.kind)).toEqual(['normal', 'normal', 'refusal', 'cancellation', 'timeout', 'permission-denied', 'recovery']);
    expect(prepared.execution).toMatchObject({ requiresIsolatedTask: true, autoInstall: false, permissions: [], dependencies: [], timeoutMs: 500 });
    expect(prepared.effectiveness).toBe('not-run');
    expect(prepared.proposal).toMatchObject({ payload: { inputSchema: tool().payload.inputSchema, outputSchema: tool().payload.outputSchema } });
  });

  it('rejects absolute valid parameters and unsafe schema regexes without evaluating them', () => {
    const candidate = tool();
    candidate.payload.inputSchema.properties.job.pattern = '^(a+)+$';
    expect(() => prepareAssetProposal(candidate, inventory())).toThrow(/pattern|schema/i);
    delete (candidate.payload.inputSchema.properties.job as { pattern?: string }).pattern;
    candidate.payload.tests[0].input = '{"job":"/tmp/private"}';
    expect(() => prepareAssetProposal(candidate, inventory())).toThrow(/absolute|path/i);
  });

  it('fails closed on unsupported schema formats and external references', () => {
    const candidate = tool();
    Object.assign(candidate.payload.inputSchema.properties.job, { format: 'untrusted-format' });
    expect(() => prepareAssetProposal(candidate, inventory())).toThrow(/format/i);
    candidate.payload.inputSchema = { $ref: 'https://example.invalid/schema.json' } as never;
    expect(() => prepareAssetProposal(candidate, inventory())).toThrow(/reference|schema/i);
  });

  it('requires actual inventory search and prefers an existing CLI over generated source', () => {
    const catalog = inventory();
    expect(() => prepareAssetProposal(tool(), { ...catalog, toolSearches: ['script'] })).toThrow(/search/i);
    catalog.tools.push({ kind: 'cli', ref: 'cli:checkpoint', name: 'checkpoint', description: 'Checkpoint formatter', provenance: 'package:checkpoint@1' });
    expect(() => prepareAssetProposal(tool(), catalog)).toThrow(/existing|reuse/i);
  });

  it('rejects invalid schemas, fabricated valid cases and malicious input accepted by a weak schema', () => {
    const candidate = tool();
    candidate.payload.inputSchema = { type: 'wrong' } as never;
    expect(() => prepareAssetProposal(candidate, inventory())).toThrow(/schema/i);
    candidate.payload.inputSchema = tool().payload.inputSchema;
    candidate.payload.tests[1].input = candidate.payload.tests[0].input;
    expect(() => prepareAssetProposal(candidate, inventory())).toThrow(/distinct|two/i);
    candidate.payload.tests[1].input = '{"job":"beta"}';
    delete (candidate.payload.inputSchema.properties.job as { pattern?: string }).pattern;
    expect(() => prepareAssetProposal(candidate, inventory())).toThrow(/refusal|invalid|malicious/i);
  });

  it('does not accept model authority, paths or execution commands', () => {
    expect(() => prepareAssetProposal({ ...tool(), command: ['sh', '-c', 'touch /tmp/pwned'] }, inventory())).toThrow();
    expect(() => prepareAssetProposal({ ...tool(), targetRef: '/tmp/pwned' }, inventory())).toThrow();
    expect(() => prepareAssetProposal({ ...skill(), targetRef: 'skill:other' }, inventory())).toThrow(/target/i);
  });
});

function task(content: string, passed: boolean): ProposalVerificationTask {
  const root = directory();
  writeFileSync(join(root, 'asset.txt'), content);
  return { isolation: 'filesystem', artifactPath: 'asset.txt',
    workspace: { id: root, path: root, runId: root, repository: { url: 'file:fixture' }, snapshot: { commit: 'abc', branch: 'test', dirty: true } },
    sandbox: { id: root, workspacePath: root, worktreePath: root },
    verification: { id: 'independent-harness', capabilities: { 'test-execution': true, 'static-analysis': false, 'custom-script': false },
      verify: vi.fn(async () => ({ passed, durationMs: 1, output: passed ? 'Assertions passed' : 'Assertion failed' })) },
  };
}

describe('isolated independent verification seam', () => {
  it.each([null, undefined])('preserves cancellation reason %s during selection and ignores late completion', async reason => {
    const prepared = prepareAssetProposal(tool(), inventory());
    const selected = task(prepared.artifact.content, true);
    const controller = new AbortController();
    const signal = { get aborted() { return controller.signal.aborted; }, get reason() { return reason; },
      addEventListener: controller.signal.addEventListener.bind(controller.signal), removeEventListener: controller.signal.removeEventListener.bind(controller.signal) };
    let finish!: (selected: ProposalVerificationTask) => void;
    const selectTask = vi.fn(() => new Promise<ProposalVerificationTask>(accept => { finish = accept; }));
    const running = verifyAssetProposal(prepared, selectTask, { signal }).then(value => ({ failed: false, value }), error => ({ failed: true, value: error }));
    await vi.waitFor(() => expect(selectTask).toHaveBeenCalledTimes(1));
    controller.abort(reason);
    const result = await running;
    finish(selected);
    await new Promise<void>(accept => setImmediate(accept));
    expect(result.failed).toBe(true);
    expect(result.value).toBe(reason);
    expect(selectTask).toHaveBeenCalledTimes(1);
    expect(selected.verification.verify).not.toHaveBeenCalled();
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });

  it.each(['resolve', 'reject'] as const)('cancels task selection before its late %s without continuing verification', async completion => {
    const prepared = prepareAssetProposal(tool(), inventory());
    const selected = task(prepared.artifact.content, true);
    const workspace = selected.workspace;
    const readWorkspace = vi.fn(() => workspace);
    Object.defineProperty(selected, 'workspace', { get: readWorkspace });
    let resolveSelection!: (value: ProposalVerificationTask) => void;
    let rejectSelection!: (reason: Error) => void;
    const pending = new Promise<ProposalVerificationTask>((resolveTask, rejectTask) => {
      resolveSelection = resolveTask;
      rejectSelection = rejectTask;
    });
    let selectionSignal: ProviderOperationOptions['signal'];
    const selectTask = vi.fn((_check: unknown, _version: unknown, operation?: ProviderOperationOptions) => {
      selectionSignal = operation?.signal;
      return pending;
    });
    const controller = new AbortController();
    const reason = new Error('Cancelled during task selection');
    let settled: unknown;
    const running = verifyAssetProposal(prepared, selectTask, { signal: controller.signal })
      .then(result => { settled = result; }, error => { settled = error; });
    await vi.waitFor(() => expect(selectTask).toHaveBeenCalledTimes(1));
    controller.abort(reason);
    try {
      await vi.waitFor(() => expect(settled).toBe(reason), { timeout: 500, interval: 10 });
      expect(selectionSignal).toBe(controller.signal);
      expect(getEventListeners(controller.signal, 'abort')).toEqual([]);
    } finally {
      if (completion === 'resolve') resolveSelection(selected);
      else rejectSelection(new Error('Late task selection failure'));
      await running;
      await new Promise<void>(resolveTurn => setImmediate(resolveTurn));
    }
    expect(settled).toBe(reason);
    expect(selectTask).toHaveBeenCalledTimes(1);
    expect(readWorkspace).not.toHaveBeenCalled();
    expect(selected.verification.verify).not.toHaveBeenCalled();
  });

  it('keeps generic provider success out of old/new behavior results', async () => {
    const prepared = prepareAssetProposal(skill(), inventory());
    const baseline = task(original, false);
    const proposed = task(prepared.artifact.content, true);
    const report = await verifyAssetProposal(prepared, (_check, version) => version === 'original' ? baseline : proposed);
    expect(report.assurance).toBe('diagnostic-only');
    expect(report.status).toBe('verification-observed');
    expect(report.comparisons).toHaveLength(3);
    expect(report.comparisons.every(entry => entry.original?.status === 'not-executed' && entry.proposed.status === 'not-executed')).toBe(true);
    expect(report.comparisons.every(entry => !('passed' in entry.original!) && !('passed' in entry.proposed))).toBe(true);
    expect(report.comparisons[0].proposed).toMatchObject({ artifactDigest: prepared.artifact.digest, runId: proposed.workspace.runId,
      workspaceId: proposed.workspace.id, sandboxId: proposed.sandbox.id, verifierId: proposed.verification.id });
    expect(proposed.verification.verify).not.toHaveBeenCalled();
    expect(report).not.toHaveProperty('published');
  });

  it('rejects weak isolation and tampered staged content before any provider call', async () => {
    const prepared = prepareAssetProposal(tool(), inventory());
    const weak = task(prepared.artifact.content, true);
    weak.isolation = 'workspace';
    await expect(verifyAssetProposal(prepared, () => weak)).rejects.toThrow(/isolation/i);
    expect(weak.verification.verify).not.toHaveBeenCalled();
    weak.isolation = 'filesystem';
    writeFileSync(join(weak.workspace.path!, 'asset.txt'), 'tampered');
    await expect(verifyAssetProposal(prepared, () => weak)).rejects.toThrow(/digest/i);
    expect(weak.verification.verify).not.toHaveBeenCalled();
  });

  it('honors cancellation and refuses host verification even with a harness and filesystem label', async () => {
    const prepared = prepareAssetProposal(tool(), inventory());
    const selected = task(prepared.artifact.content, true);
    const controller = new AbortController();
    controller.abort(new Error('Cancelled'));
    await expect(verifyAssetProposal(prepared, () => selected, { signal: controller.signal })).rejects.toThrow(/cancel/i);
    expect(selected.verification.verify).not.toHaveBeenCalled();
    const failure = vi.fn(async () => { throw new Error('Permission denied'); });
    selected.harness = { id: 'permission-harness-v1', command: () => [process.execPath, '-e', ''] };
    selected.verification.verify = failure;
    const report = await verifyAssetProposal(prepared, () => selected);
    expect(report.comparisons.every(entry => entry.proposed.status === 'unsupported')).toBe(true);
    expect(failure).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform !== 'darwin')('keeps real document assertions in static observations rather than behavior coverage', async () => {
    const prepared = prepareAssetProposal(skill(), inventory());
    const originalTask = behaviorTask(original);
    const proposedTask = behaviorTask(prepared.artifact.content);
    const assertions = {
      normal: 'assert(source.includes("Parameterize the job identifier"))',
      recovery: 'assert(source.includes("Keep the original checkpoint"))',
      refusal: 'assert(source.includes("NEVER install dependencies")); assert(source.includes("disable-model-invocation: true"))',
    };
    const report = await verifyAssetProposal(prepared, (_check, version) => {
      const selected = version === 'original' ? originalTask : proposedTask;
      selected.verification = new StaticScanVerificationProvider();
      selected.harness = { id: 'trusted-document-scan-v1', command: ({ check }) => [process.execPath, '-e',
        `const assert = require("node:assert/strict"); const fs = require("node:fs"); const source = fs.readFileSync("asset.txt", "utf8"); ${assertions[check.kind as keyof typeof assertions]}`,
      ] };
      return selected;
    });
    expect(report.comparisons.map(entry => {
      if (entry.original?.status !== 'static-observed' || entry.proposed.status !== 'static-observed') throw new Error('Expected static observations');
      return [entry.original.staticObservation.passed, entry.proposed.staticObservation.passed];
    })).toEqual([[false, true], [false, true], [true, true]]);
    expect(report.comparisons.every(entry => entry.proposed.status === 'static-observed' && !('passed' in entry.proposed))).toBe(true);
  });

  it.skipIf(process.platform !== 'darwin')('refuses successful observations if verification rewrites the staged source', async () => {
    const prepared = prepareAssetProposal(tool(), inventory());
    const selected = behaviorTask(prepared.artifact.content);
    selected.verification = { id: selected.verification.id,
      capabilities: { 'test-execution': false, 'static-analysis': true, 'custom-script': false },
      verify: selected.verification.verify.bind(selected.verification) };
    let calls = 0;
    selected.harness = { id: 'mutation-harness-v1', command: () => {
      if (++calls === prepared.checks.length) writeFileSync(join(selected.workspace.path!, 'asset.txt'), 'rewritten');
      return [process.execPath, '-e', ''];
    } };
    await expect(verifyAssetProposal(prepared, () => selected)).rejects.toThrow(/digest|changed/i);
  });
});

describe('Erdos proposal regressions', () => {
  it('does not fan an echo-only test runner success out into behavioral or control coverage', async () => {
    const prepared = prepareAssetProposal(tool(), inventory());
    const selected = task(prepared.artifact.content, true);
    selected.verification = new TestRunnerVerificationProvider({ command: [process.execPath, '-e', 'process.stdout.write("NO CANDIDATE EXECUTED")'] });
    const report = await verifyAssetProposal(prepared, () => selected);
    expect(report.comparisons).toHaveLength(7);
    for (const entry of report.comparisons) {
      expect(entry.proposed.status).toBe('not-executed');
      expect(entry.proposed).not.toHaveProperty('passed');
    }
  });

  it.skipIf(process.platform !== 'darwin')('reports static scans separately from every old/new behavior', async () => {
    const prepared = prepareAssetProposal(skill(), inventory());
    const baseline = behaviorTask(original);
    const proposed = behaviorTask(prepared.artifact.content);
    for (const selected of [baseline, proposed]) {
      selected.verification = new StaticScanVerificationProvider();
      selected.harness = { id: 'trusted-static-only-v1', command: () => [process.execPath, '-e', 'process.stdout.write("STATIC ONLY")'] };
    }
    const report = await verifyAssetProposal(prepared, (_check, version) => version === 'original' ? baseline : proposed);
    for (const entry of report.comparisons) {
      expect(entry.original?.status).toBe('static-observed');
      expect(entry.proposed.status).toBe('static-observed');
      expect(entry.original).not.toHaveProperty('passed');
      expect(entry.proposed).not.toHaveProperty('passed');
    }
  });

  it('rejects a foreign worktree before invoking any verifier', async () => {
    const prepared = prepareAssetProposal(tool(), inventory());
    const selected = task(prepared.artifact.content, true);
    selected.sandbox = { ...selected.sandbox, worktreePath: directory() };
    await expect(verifyAssetProposal(prepared, () => selected)).rejects.toThrow(/worktree|ownership/i);
    expect(selected.verification.verify).not.toHaveBeenCalled();
  });

  it('rejects old/new tasks from different repositories before executing either', async () => {
    const prepared = prepareAssetProposal(skill(), inventory());
    const baseline = task(original, true);
    const proposed = task(prepared.artifact.content, true);
    proposed.workspace = { ...proposed.workspace, repository: { url: 'file:unrelated-repository' } };
    await expect(verifyAssetProposal(prepared, (_check, version) => version === 'original' ? baseline : proposed)).rejects.toThrow(/repository/i);
    expect(baseline.verification.verify).not.toHaveBeenCalled();
    expect(proposed.verification.verify).not.toHaveBeenCalled();
  });

  it('refuses cross-kind, missing, metadata-only and mismatched-kind explicit tool targets', () => {
    const catalog = inventory();
    catalog.tools.push({ kind: 'cli', ref: 'cli:archiver', name: 'archiver', description: 'Archive binary blobs', provenance: 'package:archive@1' });
    expect(() => prepareAssetProposal({ ...tool(), targetRef: 'cli:archiver' }, catalog)).toThrow(/bytes|source|digest/i);
    expect(() => prepareAssetProposal({ ...tool(), targetRef: 'skill:recover' }, catalog)).toThrow(/target|kind/i);
    expect(() => prepareAssetProposal({ ...tool(), targetRef: 'cli:missing' }, catalog)).toThrow(/target|inventory/i);
    catalog.tools[0].kind = 'script';
    expect(() => prepareAssetProposal({ ...tool(), targetRef: 'cli:archiver' }, catalog)).toThrow(/kind|target/i);
  });

  it('binds an explicit tool patch to bytes supplied by trusted inventory despite an unrelated title', () => {
    const catalog = inventory();
    const root = directory();
    const source = 'export const archive = () => false;\n';
    writeFileSync(join(root, 'archive.mjs'), source);
    catalog.tools.push({ kind: 'cli', ref: 'cli:archiver', name: 'archiver', description: 'Archive binary blobs', provenance: 'package:archive@1',
      source: { root, file: join(root, 'archive.mjs') } });
    const prepared = prepareAssetProposal({ ...tool(), targetRef: 'cli:archiver' }, catalog);
    expect(prepared.artifact.originalDigest).toBe(digest(source));
    expect(prepared.artifact.targetRef).toBe('cli:archiver');
    expect(prepared.artifact.content).toBe(tool().payload.source);
  });

  it.each(['/tmp/absolute', 'C:\\Windows\\absolute', '\\\\server\\share\\absolute', 'file:/tmp/absolute'])('rejects absolute parameter mapping key %s', key => {
    const candidate = tool();
    candidate.payload.inputSchema = { type: 'object', properties: { files: { type: 'object', additionalProperties: { type: 'string' } } }, required: ['files'], additionalProperties: false } as never;
    candidate.payload.tests[0].input = JSON.stringify({ files: { [key]: 'alpha' } });
    candidate.payload.tests[1].input = '{"files":{"relative":"beta"}}';
    candidate.payload.tests[2].input = '{"files":17}';
    expect(() => prepareAssetProposal(candidate, inventory())).toThrow(/absolute|path/i);
  });

  it('keeps schema dialect URLs outside the parameter file-path boundary', () => {
    const candidate = tool();
    Object.assign(candidate.payload.inputSchema, { $schema: 'http://json-schema.org/draft-07/schema#' });
    expect(prepareAssetProposal(candidate, inventory()).status).toBe('verification-prepared');
  });
});

function behaviorTask(content: string): ProposalVerificationTask {
  const selected = task(content, false);
  selected.sandbox = new LocalSandbox({ id: selected.sandbox.id, worktreePath: selected.workspace.path!, sessionName: 'proposal-behavior-test',
    workspaceRoot: selected.workspace.path!, runtimeRunId: selected.workspace.runId });
  selected.verification = new TestRunnerVerificationProvider();
  selected.harness = { id: 'trusted-node-json-v1', command: request => [process.execPath, '-e', [
    'const { spawnSync } = require("node:child_process");',
    'const assert = require("node:assert/strict");',
    'const request = JSON.parse(process.argv[1]);',
    'let result;',
    'if (request.check.kind !== "normal") result = { status: "unsupported", reason: "Fixture implements only JSON normal-case assertions" };',
    'else {',
    '  const child = spawnSync(process.execPath, [request.artifactPath, request.check.input], { encoding: "utf8", timeout: request.timeoutMs });',
    '  let passed = false;',
    '  try { assert.equal(child.status, 0); assert.deepEqual(JSON.parse(child.stdout), JSON.parse(request.check.expected)); passed = true; } catch {}',
    '  result = { status: "executed", passed, assertions: 1, actual: { exitCode: child.status, stdout: child.stdout, stderr: child.stderr } };',
    '}',
    'process.stdout.write(JSON.stringify({ version: 1, binding: request.binding, result }));',
  ].join('\n'), JSON.stringify(request)] };
  return selected;
}

describe.skipIf(process.platform !== 'darwin')('case-bound trusted harness receipts', () => {
  it.each([
    { phase: 'captureOutput', position: 'first', abortAt: 1 },
    { phase: 'captureOutput', position: 'last', abortAt: 2 },
    { phase: 'cleanup', position: 'first', abortAt: 1 },
    { phase: 'cleanup', position: 'last', abortAt: 2 },
  ].flatMap(testCase => [new Error(`Cancelled during ${testCase.phase}`), null, undefined].map(reason => ({ ...testCase, reason }))))('preserves cancellation $reason during $phase of the $position case without later execution', async ({ phase, abortAt, reason }) => {
    const candidate = tool();
    candidate.payload.source = 'process.stdout.write(JSON.stringify({ok:true}));';
    const prepared = prepareAssetProposal(candidate, inventory());
    prepared.checks = prepared.checks.filter(check => check.kind === 'normal');
    expect(prepared.checks).toHaveLength(2);
    const selected = behaviorTask(prepared.artifact.content);
    const controller = new AbortController();
    const signal = { get aborted() { return controller.signal.aborted; }, get reason() { return reason; },
      addEventListener: controller.signal.addEventListener.bind(controller.signal), removeEventListener: controller.signal.removeEventListener.bind(controller.signal) };
    const captured: boolean[] = [];
    const cleaned = vi.fn();
    const originalStart = LocalSandbox.prototype.startAgent;
    let started = 0;
    const start = vi.spyOn(LocalSandbox.prototype, 'startAgent').mockImplementation(async function (this: LocalSandbox, options) {
      const execution = await originalStart.call(this, options);
      const current = ++started;
      let outputCaptured = false;
      const captureOutput = execution.captureOutput.bind(execution);
      execution.captureOutput = async captureOptions => {
        const output = await captureOutput(captureOptions);
        captured.push(JSON.parse(output).result.passed);
        outputCaptured = true;
        if (phase === 'captureOutput' && current === abortAt) controller.abort(reason);
        return output;
      };
      const kill = execution.kill.bind(execution);
      execution.kill = async () => {
        await kill();
        cleaned(current);
        if (phase === 'cleanup' && outputCaptured && current === abortAt) controller.abort(reason);
      };
      return execution;
    });
    try {
      await expect(verifyAssetProposal(prepared, () => selected, { signal })).rejects.toBe(reason);
      expect(signal.reason).toBe(reason);
      expect(captured).toEqual(Array.from({ length: abortAt }, () => true));
      expect(start).toHaveBeenCalledTimes(abortAt);
      expect(cleaned).toHaveBeenCalledWith(abortAt);
      expect(getEventListeners(controller.signal, 'abort')).toEqual([]);
    } finally { start.mockRestore(); }
  });

  it('does not launch a sandbox when command selection cancels verification', async () => {
    const prepared = prepareAssetProposal(tool(), inventory());
    const selected = behaviorTask(prepared.artifact.content);
    const controller = new AbortController();
    const reason = new Error('Cancelled during command selection');
    selected.harness = { id: 'cancel-command-v1', command: () => {
      controller.abort(reason);
      return [process.execPath, '-e', 'setInterval(() => {}, 1000)'];
    } };
    const start = vi.spyOn(LocalSandbox.prototype, 'startAgent');
    try {
      await expect(verifyAssetProposal(prepared, () => selected, { signal: controller.signal })).rejects.toBe(reason);
      expect(start).not.toHaveBeenCalled();
    } finally { start.mockRestore(); }
  });

  it('runs distinct actual inputs and leaves unimplemented controls unsupported', async () => {
    const candidate = tool();
    candidate.payload.source = 'const input = JSON.parse(process.argv[2]); process.stdout.write(JSON.stringify({ok: input.job === "alpha" || input.job === "beta"}));';
    const prepared = prepareAssetProposal(candidate, inventory());
    const selected = behaviorTask(prepared.artifact.content);
    const report = await verifyAssetProposal(prepared, () => selected);
    expect(report.comparisons.slice(0, 2).map(entry => entry.proposed.status)).toEqual(['behavior-executed', 'behavior-executed']);
    expect(report.comparisons.slice(0, 2).every(entry => entry.proposed.passed === true)).toBe(true);
    for (const entry of report.comparisons.slice(2)) {
      expect(entry.proposed.status).toBe('unsupported');
      expect(entry.proposed).not.toHaveProperty('passed');
    }
    const first = report.comparisons[0].proposed;
    const second = report.comparisons[1].proposed;
    if (first.status !== 'behavior-executed' || second.status !== 'behavior-executed') throw new Error('Expected executed behavior receipts');
    expect(first.receipt.binding.inputDigest).not.toBe(second.receipt.binding.inputDigest);
    expect(first.receipt.binding.executionId).not.toBe(second.receipt.binding.executionId);
    expect(first.receipt.binding.artifactDigest).toBe(prepared.artifact.digest);
    expect(first.receiptDigest).toMatch(/^[a-f0-9]{64}$/);
  }, 15000);

  it('records failed normal behavior when the actual candidate always throws despite harness exit zero', async () => {
    const prepared = prepareAssetProposal(tool(), inventory());
    const report = await verifyAssetProposal(prepared, () => behaviorTask(prepared.artifact.content));
    expect(report.comparisons.slice(0, 2).every(entry => entry.proposed.status === 'behavior-executed' && entry.proposed.passed === false)).toBe(true);
    expect(report.comparisons.slice(2).every(entry => !('passed' in entry.proposed))).toBe(true);
  });

  it('compares original and proposed tool behavior using independent input and result receipts', async () => {
    const candidate = tool();
    const catalog = inventory();
    const root = directory();
    const baselineSource = 'process.stdout.write(JSON.stringify({ok: false}));';
    writeFileSync(join(root, 'tool.js'), baselineSource);
    catalog.tools.push({ kind: 'script', ref: 'script:formatter', name: 'formatter', description: 'Checkpoint formatter', provenance: 'repository:fixture',
      source: { root, file: join(root, 'tool.js') } });
    candidate.payload.source = 'process.stdout.write(JSON.stringify({ok: true}));';
    const prepared = prepareAssetProposal({ ...candidate, targetRef: 'script:formatter' }, catalog);
    const baseline = behaviorTask(baselineSource);
    const proposed = behaviorTask(prepared.artifact.content);
    const report = await verifyAssetProposal(prepared, (_check, version) => version === 'original' ? baseline : proposed);
    for (const entry of report.comparisons.slice(0, 2)) {
      expect(entry.original).toMatchObject({ status: 'behavior-executed', passed: false, artifactDigest: digest(baselineSource) });
      expect(entry.proposed).toMatchObject({ status: 'behavior-executed', passed: true, artifactDigest: prepared.artifact.digest });
    }
    expect(report.comparisons.slice(2).every(entry => entry.original?.status === 'unsupported' && entry.proposed.status === 'unsupported')).toBe(true);
  });

  it.each(['executionId', 'checkId', 'checkDigest', 'inputDigest', 'artifactDigest', 'taskDigest', 'harnessId', 'version'])('rejects a receipt with a mismatched %s', async field => {
    const prepared = prepareAssetProposal(tool(), inventory());
    const selected = behaviorTask(prepared.artifact.content);
    let request: ProposalHarnessRequest;
    selected.harness!.command = input => {
      request = input;
      const receipt = { version: 1, binding: { ...input.binding, [field]: field === 'executionId' ? '00000000-0000-4000-8000-000000000001'
        : field === 'version' ? 'original' : field.endsWith('Digest') ? '0'.repeat(64) : 'wrong' },
      result: { status: 'executed', passed: true, assertions: 1, actual: { ok: true } },
      };
      return [process.execPath, '-e', 'process.stdout.write(process.argv[1])', JSON.stringify(receipt)];
    };
    await expect(verifyAssetProposal(prepared, () => selected)).rejects.toThrow(/receipt|binding/i);
    expect(request!).toBeDefined();
  });

  it('does not accept a harness label or echo without an executed receipt', async () => {
    const prepared = prepareAssetProposal(tool(), inventory());
    const selected = behaviorTask(prepared.artifact.content);
    selected.harness!.command = () => [process.execPath, '-e', 'process.stdout.write("PASSED")'];
    const report = await verifyAssetProposal(prepared, () => selected);
    expect(report.comparisons.every(entry => entry.proposed.status === 'not-executed' && !('passed' in entry.proposed))).toBe(true);
  });
});

describe.skipIf(process.platform !== 'darwin')('Darwin isolation and comparison regressions', () => {
  it('does not let a static provider execute candidate code on the host', async () => {
    const outside = join(directory(), 'static-escaped');
    const candidate = tool();
    candidate.payload.source = `require('node:fs').writeFileSync(${JSON.stringify(outside)}, 'escaped');`;
    const prepared = prepareAssetProposal(candidate, inventory());
    const selected = task(prepared.artifact.content, true);
    selected.verification = new StaticScanVerificationProvider({ command: [process.execPath, '-e', candidate.payload.source] });
    const report = await verifyAssetProposal(prepared, () => selected);
    expect(existsSync(outside)).toBe(false);
    expect(report.comparisons.every(entry => entry.proposed.status === 'not-executed')).toBe(true);
  });

  it('runs explicit static harnesses under the same OS policy', async () => {
    const outside = join(directory(), 'static-escaped');
    const candidate = tool();
    candidate.payload.source = `require('node:fs').writeFileSync(${JSON.stringify(outside)}, 'escaped');`;
    const prepared = prepareAssetProposal(candidate, inventory());
    const selected = behaviorTask(prepared.artifact.content);
    selected.verification = new StaticScanVerificationProvider();
    selected.harness = { id: 'trusted-static-probe-v1', command: () => [process.execPath, '-e', candidate.payload.source] };
    const report = await verifyAssetProposal(prepared, () => selected);
    expect(existsSync(outside)).toBe(false);
    expect(report.comparisons.every(entry => entry.proposed.status === 'static-observed' && !entry.proposed.staticObservation.passed)).toBe(true);
  });

  it('does not execute a candidate using only a filesystem label and cwd', async () => {
    const outside = join(directory(), 'escaped');
    const candidate = tool();
    candidate.payload.source = `require('node:fs').writeFileSync(${JSON.stringify(outside)}, 'escaped'); process.stdout.write(JSON.stringify({ok:true}));`;
    const prepared = prepareAssetProposal(candidate, inventory());
    const selected = behaviorTask(prepared.artifact.content);
    selected.sandbox = { id: selected.sandbox.id, workspacePath: selected.sandbox.workspacePath, worktreePath: selected.sandbox.worktreePath };
    const report = await verifyAssetProposal(prepared, () => selected);
    expect(existsSync(outside)).toBe(false);
    expect(report.comparisons.every(entry => entry.proposed.status === 'unsupported' && !('passed' in entry.proposed))).toBe(true);
  });

  it('fails actual normal execution when an otherwise correct candidate attempts an uncaught outside write', async () => {
    const outside = join(directory(), 'escaped');
    const candidate = tool();
    candidate.payload.source = `require('node:fs').writeFileSync(${JSON.stringify(outside)}, 'escaped'); process.stdout.write(JSON.stringify({ok:true}));`;
    const prepared = prepareAssetProposal(candidate, inventory());
    const report = await verifyAssetProposal(prepared, () => behaviorTask(prepared.artifact.content));
    expect(existsSync(outside)).toBe(false);
    expect(report.comparisons.slice(0, 2).every(entry => entry.proposed.status === 'behavior-executed' && entry.proposed.passed === false)).toBe(true);
  });

  it('blocks outside reads and writes in a real child while permitting normal JSON behavior', async () => {
    const outside = directory();
    writeFileSync(join(outside, 'secret'), 'host-private');
    const candidate = tool();
    candidate.payload.source = [
      'const fs = require("node:fs"); let blocked = 0;',
      `try { fs.readFileSync(${JSON.stringify(join(outside, 'secret'))}); } catch (error) { if (error.code === 'EPERM' || error.code === 'EACCES') blocked++; }`,
      `try { fs.writeFileSync(${JSON.stringify(join(outside, 'escaped'))}, 'escaped'); } catch (error) { if (error.code === 'EPERM' || error.code === 'EACCES') blocked++; }`,
      `try { fs.readFileSync(${JSON.stringify(join(outside, 'outside-link'))}); } catch (error) { if (error.code === "EPERM" || error.code === "EACCES") blocked++; }`,
      `const child = require('node:child_process').spawnSync(process.execPath, ['-e', ${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(join(outside, 'descendant-escaped'))}, 'escaped')`)}], {encoding: 'utf8'});`,
      'process.stdout.write(JSON.stringify({ok: blocked === 3 && child.status !== 0 && /EPERM|EACCES/.test(child.stderr) && process.env.PROPOSALS_HOST_SECRET === undefined}));',
    ].join('\n');
    vi.stubEnv('PROPOSALS_HOST_SECRET', 'host-private');
    try {
      const prepared = prepareAssetProposal(candidate, inventory());
      const selected = behaviorTask(prepared.artifact.content);
      symlinkSync(join(outside, 'secret'), join(outside, 'outside-link'));
      const hostVerify = vi.spyOn(selected.verification, 'verify');
      const report = await verifyAssetProposal(prepared, () => selected);
      expect(existsSync(join(outside, 'escaped'))).toBe(false);
      expect(existsSync(join(outside, 'descendant-escaped'))).toBe(false);
      expect(report.comparisons.slice(0, 2).map(entry => entry.proposed)).toEqual([
        expect.objectContaining({ status: 'behavior-executed', passed: true }),
        expect.objectContaining({ status: 'behavior-executed', passed: true }),
      ]);
      expect(readFileSync(join(outside, 'secret'), 'utf8')).toBe('host-private');
      expect(hostVerify).not.toHaveBeenCalled();
      for (const entry of report.comparisons.slice(0, 2)) {
        if (entry.proposed.status !== 'behavior-executed') throw new Error('Expected actual sandbox execution');
        expect(entry.proposed.execution).toMatchObject({ mechanism: 'darwin-seatbelt', sandboxId: selected.sandbox.id, snapshotCommit: 'abc' });
        expect(entry.proposed.execution.id).toBeTruthy();
        expect(entry.proposed.execution.policyDigest).toMatch(/^[a-f0-9]{64}$/);
      }
    } finally { vi.unstubAllEnvs(); }
  });

  it('rejects different snapshot commits before helper differences can look like candidate improvements', async () => {
    const candidate = tool();
    candidate.payload.source = 'process.stdout.write(JSON.stringify({ok: require("./helper.cjs")}));';
    const catalog = inventory();
    const root = directory();
    writeFileSync(join(root, 'source.js'), candidate.payload.source);
    catalog.tools.push({ kind: 'script', ref: 'script:formatter', name: 'formatter', description: 'Checkpoint formatter', provenance: 'repository:fixture',
      source: { root, file: join(root, 'source.js') } });
    const prepared = prepareAssetProposal({ ...candidate, targetRef: 'script:formatter' }, catalog);
    const baseline = behaviorTask(prepared.artifact.content);
    const proposed = behaviorTask(prepared.artifact.content);
    writeFileSync(join(baseline.workspace.path!, 'helper.cjs'), 'module.exports = false;');
    writeFileSync(join(proposed.workspace.path!, 'helper.cjs'), 'module.exports = true;');
    proposed.workspace = { ...proposed.workspace, snapshot: { ...proposed.workspace.snapshot, commit: 'different-commit' } };
    const start = vi.spyOn(LocalSandbox.prototype, 'startAgent');
    try {
      await expect(verifyAssetProposal(prepared, (_check, version) => version === 'original' ? baseline : proposed)).rejects.toThrow(/snapshot|commit|baseline/i);
      expect(start).not.toHaveBeenCalled();
    } finally { start.mockRestore(); }
  });
});

describe.skipIf(process.platform !== 'darwin')('Leibniz execution context regressions', () => {
  function helperComparison(originalHelper: string, proposedHelper: string) {
    const candidate = tool();
    candidate.payload.source = 'process.stdout.write(JSON.stringify({ok: require("./helper.cjs")}));';
    const catalog = inventory();
    const root = directory();
    writeFileSync(join(root, 'source.js'), candidate.payload.source);
    catalog.tools.push({ kind: 'script', ref: 'script:formatter', name: 'formatter', description: 'Checkpoint formatter', provenance: 'repository:fixture',
      source: { root, file: join(root, 'source.js') } });
    const prepared = prepareAssetProposal({ ...candidate, targetRef: 'script:formatter' }, catalog);
    const baseline = behaviorTask(prepared.artifact.content);
    const proposed = behaviorTask(prepared.artifact.content);
    writeFileSync(join(baseline.workspace.path!, 'helper.cjs'), originalHelper);
    writeFileSync(join(proposed.workspace.path!, 'helper.cjs'), proposedHelper);
    return { prepared, baseline, proposed };
  }

  it('rejects same-commit dirty helper differences before any sandbox execution', async () => {
    const { prepared, baseline, proposed } = helperComparison('module.exports = false;', 'module.exports = true;');
    expect(prepared.artifact.originalDigest).toBe(prepared.artifact.digest);
    expect(baseline.workspace.snapshot).toEqual(proposed.workspace.snapshot);
    expect(baseline.workspace.snapshot.dirty).toBe(true);
    const start = vi.spyOn(LocalSandbox.prototype, 'startAgent');
    try {
      await expect(verifyAssetProposal(prepared, (_check, version) => version === 'original' ? baseline : proposed)).rejects.toThrow(/input.*tree|context/i);
      expect(start).not.toHaveBeenCalled();
    } finally { start.mockRestore(); }
  });

  it('allows equal dirty input trees and retains the actual OS argv and cwd bound to the receipt', async () => {
    const { prepared, baseline, proposed } = helperComparison('module.exports = true;', 'module.exports = true;');
    const start = vi.spyOn(LocalSandbox.prototype, 'startAgent');
    try {
      const report = await verifyAssetProposal(prepared, (_check, version) => version === 'original' ? baseline : proposed);
      for (const entry of report.comparisons.slice(0, 2)) for (const observation of [entry.original!, entry.proposed]) {
        expect(observation).toMatchObject({ status: 'behavior-executed', passed: true });
        if (observation.status !== 'behavior-executed') throw new Error('Expected isolated execution');
        const execution = observation.execution as typeof observation.execution & { argv: string[]; cwd: string; commandDigest: string; inputTreeDigest: string };
        const call = start.mock.calls.find(([options]) => canonicalCommand(options.command.argv, options.command.cwd!) === canonicalCommand(execution.argv, execution.cwd));
        expect(call).toBeDefined();
        expect(execution.argv[0]).toBe('/usr/bin/sandbox-exec');
        expect(execution.commandDigest).toBe(digest(canonicalCommand(execution.argv, execution.cwd)));
        expect(execution.inputTreeDigest).toMatch(/^[a-f0-9]{64}$/);
        expect(observation.receiptDigest).toBe(digest(canonicalLearningJson({ receipt: observation.receipt, execution })));
      }
    } finally { start.mockRestore(); }
  }, 15000);

  it('rechecks helper contents after trusted command selection and before execution', async () => {
    const { prepared, baseline, proposed } = helperComparison('module.exports = true;', 'module.exports = true;');
    const command = baseline.harness!.command;
    baseline.harness!.command = request => {
      writeFileSync(join(baseline.workspace.path!, 'helper.cjs'), 'module.exports = false;');
      return command(request);
    };
    await expect(verifyAssetProposal(prepared, (_check, version) => version === 'original' ? baseline : proposed)).rejects.toThrow(/input.*tree|context/i);
  });

  it('rechecks helper contents after the actual sandbox execution', async () => {
    const { prepared, baseline, proposed } = helperComparison('module.exports = true;', 'module.exports = true;');
    const originalStart = LocalSandbox.prototype.startAgent;
    const start = vi.spyOn(LocalSandbox.prototype, 'startAgent').mockImplementation(async function (this: LocalSandbox, options) {
      const execution = await originalStart.call(this, options);
      const wait = execution.waitForResult.bind(execution);
      execution.waitForResult = async waitOptions => {
        const result = await wait(waitOptions);
        writeFileSync(join(baseline.workspace.path!, 'helper.cjs'), 'module.exports = false;');
        return result;
      };
      return execution;
    });
    try {
      await expect(verifyAssetProposal(prepared, (_check, version) => version === 'original' ? baseline : proposed)).rejects.toThrow(/input.*tree|context/i);
    } finally { start.mockRestore(); }
  });

  it.each(['file-link', 'directory-link', '.git'])('refuses input tree symlink %s during preflight', async name => {
    const prepared = prepareAssetProposal(tool(), inventory());
    const selected = behaviorTask(prepared.artifact.content);
    const outside = directory();
    writeFileSync(join(outside, 'helper.cjs'), 'module.exports = true;');
    symlinkSync(name === 'directory-link' ? outside : join(outside, 'helper.cjs'), join(selected.workspace.path!, name));
    await expect(verifyAssetProposal(prepared, () => selected)).rejects.toThrow(/symlink/i);
  });

  it('refuses special input entries without opening a blocking FIFO', async () => {
    const prepared = prepareAssetProposal(tool(), inventory());
    const selected = behaviorTask(prepared.artifact.content);
    execFileSync('/usr/bin/mkfifo', [join(selected.workspace.path!, 'helper.pipe')]);
    await expect(verifyAssetProposal(prepared, () => selected)).rejects.toThrow(/special/i);
  });

  it.each(['entries', 'bytes', 'depth'])('bounds input tree %s before execution', async limit => {
    const prepared = prepareAssetProposal(tool(), inventory());
    const selected = behaviorTask(prepared.artifact.content);
    const root = selected.workspace.path!;
    if (limit === 'entries') for (let index = 0; index < 1024; index++) writeFileSync(join(root, `helper-${index}`), '');
    else if (limit === 'bytes') writeFileSync(join(root, 'large-helper'), Buffer.alloc(8 * 1024 * 1024 + 1));
    else {
      let parent = root;
      for (let index = 0; index < 33; index++) { parent = join(parent, 'nested'); mkdirSync(parent); }
    }
    await expect(verifyAssetProposal(prepared, () => selected)).rejects.toThrow(/input tree.*limit/i);
  });

  it.each(['file', 'directory'])('excludes Git metadata %s contents while the actual sandbox denies reads', async kind => {
    const candidate = tool();
    const metadataPath = kind === 'file' ? '.git' : '.git/HEAD';
    candidate.payload.source = `let denied = false; try { require("node:fs").readFileSync(${JSON.stringify(metadataPath)}); } catch (error) { denied = error.code === "EPERM" || error.code === "EACCES"; } process.stdout.write(JSON.stringify({ok:denied}));`;
    const catalog = inventory();
    const root = directory();
    writeFileSync(join(root, 'source.js'), candidate.payload.source);
    catalog.tools.push({ kind: 'script', ref: 'script:formatter', name: 'formatter', description: 'Checkpoint formatter', provenance: 'repository:fixture',
      source: { root, file: join(root, 'source.js') } });
    const prepared = prepareAssetProposal({ ...candidate, targetRef: 'script:formatter' }, catalog);
    const baseline = behaviorTask(prepared.artifact.content);
    const proposed = behaviorTask(prepared.artifact.content);
    for (const [selected, contents] of [[baseline, 'baseline metadata'], [proposed, 'different proposed metadata']] as const) {
      const metadata = join(selected.workspace.path!, '.git');
      if (kind === 'directory') { mkdirSync(metadata); writeFileSync(join(metadata, 'HEAD'), contents); }
      else writeFileSync(metadata, contents);
    }
    const report = await verifyAssetProposal(prepared, (_check, version) => version === 'original' ? baseline : proposed);
    for (const entry of report.comparisons.slice(0, 2)) {
      expect(entry.original).toMatchObject({ status: 'behavior-executed', passed: true });
      expect(entry.proposed).toMatchObject({ status: 'behavior-executed', passed: true });
    }
  }, 15000);
});

function canonicalCommand(argv: readonly string[], cwd: string): string {
  return canonicalLearningJson({ argv, cwd });
}
