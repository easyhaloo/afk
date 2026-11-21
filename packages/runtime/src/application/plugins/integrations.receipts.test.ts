import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { simpleGit } from 'simple-git';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EvidenceRef, ObservationContext, RunEventData } from '@afk/core';
import type { ProviderOperationOptions, VerificationProvider, VerificationRequest } from '../../plugin-sdk/capabilities.js';
import { LocalEncryptedEvidenceStore } from '../../infrastructure/observability/local-evidence-store.js';
import { TestRunnerVerificationProvider } from '../../infrastructure/verification/index.js';
import { LifecycleDispatcher, type LifecycleContext } from '../workflows/lifecycle.js';
import { createCapabilityLifecycle } from './integrations.js';
import { PluginRuntime } from './runtime.js';

const node = process.execPath;
const roots: string[] = [];
const runtimes: PluginRuntime[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map(runtime => runtime.close()));
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function fixture(provider: VerificationProvider = new TestRunnerVerificationProvider()) {
  const root = await mkdtemp(join(tmpdir(), 'afk-verification-receipt-'));
  roots.push(root);
  const workspace = await realpath(root);
  const git = simpleGit(workspace);
  await git.init();
  await git.addConfig('user.name', 'Receipt Test');
  await git.addConfig('user.email', 'receipt@example.invalid');
  await git.commit('initial', { '--allow-empty': null });
  const before = { head: await git.revparse(['HEAD']), branch: await git.revparse(['--abbrev-ref', 'HEAD']) };
  const runtime = new PluginRuntime();
  runtimes.push(runtime);
  await runtime.activate({
    manifest: { id: 'test.receipts', version: '1.0.0', apiVersion: 1, provides: ['verification.provider'], trusted: true },
    activate: setup => setup.registerVerificationProvider('selected', provider),
  });
  const evidence = new LocalEncryptedEvidenceStore({ root: join(root, 'evidence'), encryptionKey: randomBytes(32) });
  const put = vi.spyOn(evidence, 'put');
  const observed: ObservationContext = {
    traceId: 'trace-42', runId: 'run-42', workItemId: 'github:test/repo#42', profileId: 'default', attempt: 2,
    actor: { kind: 'system', id: 'host' },
  };
  const record = vi.fn(async (_data: RunEventData, _options?: { evidence?: readonly EvidenceRef[]; idempotencyKey?: string }) => undefined);
  const context: LifecycleContext = {
    iid: 42, worktreePath: root, baseBranch: 'deliberately-not-actual', sessionName: 'afk-42', params: {},
    observation: { context: observed, record },
  };
  const request = vi.fn((_context: LifecycleContext): VerificationRequest => ({
    target: '/fake/worktree', executionId: 'untrusted-request-id', command: [node, '-e', 'console.log("verified")'], timeoutMs: 5000,
  }));
  const module = createCapabilityLifecycle(runtime, {
    verificationEvidence: evidence, verifications: [{ provider: 'selected', request }],
  });
  const receipt = async (index = 0) => {
    const ref = await put.mock.results[index].value;
    return JSON.parse(Buffer.from(await evidence.get(ref)).toString('utf8'));
  };
  return { root, workspace, git, before, runtime, provider, evidence, put, observed, record, context, request, module, receipt };
}

function reported(verify: VerificationProvider['verify']): VerificationProvider {
  return { id: 'reported', capabilities: { 'static-analysis': false, 'test-execution': true, 'custom-script': true }, verify };
}

describe('CapabilityLifecycle verification receipts', () => {
  it('persists full real command results in encrypted evidence and audits distinct phase-bound executions', async () => {
    const test = await fixture();
    const verify = vi.spyOn(test.provider, 'verify');
    const link = join(test.root, 'workspace-link');
    await symlink(test.root, link);
    test.context.worktreePath = link;
    await test.module.onAfterAgent!(test.context);
    await test.module.onBeforePublish!(test.context);
    const afterAgent = await test.receipt();
    const beforePublish = await test.receipt(1);
    expect(afterAgent).toMatchObject({
      protocol: 'capability-verification-v1', provider: 'selected', observation: test.observed,
      phase: 'after-agent', workspace: test.workspace, revision: { before: test.before, after: test.before },
      provenance: 'provider-result', outcome: 'succeeded', failures: [],
      result: { passed: true, output: 'verified\n', execution: {
        protocol: 'verification-execution-v1', command: [node, '-e', 'console.log("verified")'], cwd: test.workspace,
        inputDigest: createHash('sha256').update('').digest('hex'), exitCode: 0, stdout: 'verified\n', stderr: '', closed: true,
      } },
    });
    expect(afterAgent.executionId).toMatch(/^[a-f0-9-]{36}$/);
    expect(afterAgent.result.execution.executionId).toBe(afterAgent.executionId);
    expect(beforePublish.phase).toBe('before-publish');
    expect(beforePublish.executionId).not.toBe(afterAgent.executionId);
    expect(verify.mock.calls[0][0]).toMatchObject({ target: test.workspace, executionId: afterAgent.executionId });
    expect(test.put.mock.calls[0][0]).toMatchObject({ mediaType: 'application/json', classification: 'sensitive' });
    for (const [index, saved] of [afterAgent, beforePublish].entries()) {
      const ref = await test.put.mock.results[index].value;
      expect(test.record.mock.calls[index * 2]).toEqual([
        { kind: 'effect.started', effectKind: 'verification', idempotencyKey: saved.executionId },
        { idempotencyKey: saved.executionId },
      ]);
      expect(test.record.mock.calls[index * 2 + 1]).toEqual([
        { kind: 'effect.completed', effectKind: 'verification', idempotencyKey: saved.executionId, outcome: 'succeeded' },
        { idempotencyKey: saved.executionId, evidence: [ref] },
      ]);
    }
    expect(test.record.mock.invocationCallOrder[0]).toBeLessThan(verify.mock.invocationCallOrder[0]);
    expect(verify.mock.invocationCallOrder[0]).toBeLessThan(test.put.mock.invocationCallOrder[0]);
    expect(test.put.mock.invocationCallOrder[0]).toBeLessThan(test.record.mock.invocationCallOrder[1]);
  });

  it.each(['after-agent', 'before-publish'] as const)('saves a real nonzero result and blocks downstream %s effects', async phase => {
    const test = await fixture();
    test.request.mockReturnValue({ target: '/fake', command: [node, '-e', 'console.error("failed"); process.exit(7)'] });
    const publication = vi.fn();
    await expect(new LifecycleDispatcher([test.module, {
      name: 'publication', onAfterAgent: publication, onBeforePublish: publication,
    }]).run(phase, test.context)).rejects.toThrow('Capability verification failed');
    expect(publication).not.toHaveBeenCalled();
    expect(await test.receipt()).toMatchObject({
      phase, outcome: 'failed', revision: { before: test.before, after: test.before },
      result: { passed: false, execution: { exitCode: 7, stderr: 'failed\n', closed: true } },
      failures: [{ classification: 'verification-failed' }],
    });
    expect(test.record.mock.calls[1][0]).toMatchObject({ kind: 'effect.completed', outcome: 'failed' });
    expect(test.record.mock.calls[1][1]?.evidence).toHaveLength(1);
  });

  it('saves provider exceptions and audits failure before returning the original error', async () => {
    const error = new Error('provider offline');
    const test = await fixture(reported(async () => { throw error; }));
    await expect(test.module.onBeforePublish!(test.context)).rejects.toBe(error);
    expect(await test.receipt()).toMatchObject({ outcome: 'failed', failures: [{ classification: 'provider-exception', message: error.message }] });
    expect(test.record.mock.calls[1][0]).toMatchObject({ outcome: 'failed' });
  });

  it('waits for cancellation cleanup, then persists and audits using the cancelled context', async () => {
    const controller = new AbortController();
    const reason = new Error('verification cancelled');
    let release!: () => void;
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const cleanup = new Promise<void>(resolve => { release = resolve; });
    let cleaned = false;
    const verify = vi.fn(async (_request: VerificationRequest, options?: ProviderOperationOptions) => {
      expect(options?.signal).toBe(controller.signal);
      started();
      await cleanup;
      cleaned = true;
      return { passed: true, durationMs: 1 };
    });
    const test = await fixture(reported(verify));
    test.context = { ...test.context, signal: controller.signal };
    const operation = test.module.onBeforePublish!(test.context);
    const rejected = expect(operation).rejects.toBe(reason);
    await ready;
    controller.abort(reason);
    await Promise.resolve();
    expect(test.put).not.toHaveBeenCalled();
    expect(test.record).toHaveBeenCalledTimes(1);
    release();
    await rejected;
    expect(cleaned).toBe(true);
    expect(await test.receipt()).toMatchObject({ outcome: 'failed', failures: [{ classification: 'cancelled' }] });
    expect(test.record.mock.calls[1][0]).toMatchObject({ outcome: 'failed' });
    expect(test.record.mock.calls[1][1]?.evidence).toHaveLength(1);
  });

  it('kills and saves a cancelled real Node verification', async () => {
    const controller = new AbortController();
    const reason = new Error('native check stopped');
    const provider = new TestRunnerVerificationProvider();
    const nativeVerify = provider.verify.bind(provider);
    const verify = vi.spyOn(provider, 'verify').mockImplementation(async (request, options) => {
      const running = nativeVerify(request, options);
      controller.abort(reason);
      return running;
    });
    const test = await fixture(provider);
    test.request.mockReturnValue({ target: '/fake', command: [node, '-e', 'setInterval(() => {}, 1000)'], timeoutMs: 5000 });
    await expect(test.module.onBeforePublish!({ ...test.context, signal: controller.signal })).rejects.toBe(reason);
    expect(verify).toHaveBeenCalledTimes(1);
    expect(await test.receipt()).toMatchObject({ outcome: 'failed', failures: [{ classification: 'cancelled' }] });
    expect(test.record).toHaveBeenCalledTimes(2);
  });

  it('requires observation before evaluating the request or running selected verification', async () => {
    const test = await fixture();
    const verify = vi.spyOn(test.provider, 'verify');
    await expect(test.module.onBeforePublish!({ ...test.context, observation: undefined })).rejects.toThrow('observation context');
    expect(test.request).not.toHaveBeenCalled();
    expect(verify).not.toHaveBeenCalled();
    expect(test.put).not.toHaveBeenCalled();
    await expect(createCapabilityLifecycle(test.runtime, { verificationEvidence: test.evidence })
      .onBeforePublish!({ ...test.context, observation: undefined })).resolves.toBeUndefined();
  });

  it('prevents execution when start auditing fails and still saves a failure receipt', async () => {
    const test = await fixture();
    const error = new Error('start audit unavailable');
    test.record.mockRejectedValueOnce(error);
    const verify = vi.spyOn(test.provider, 'verify');
    await expect(test.module.onBeforePublish!(test.context)).rejects.toBe(error);
    expect(test.request).not.toHaveBeenCalled();
    expect(verify).not.toHaveBeenCalled();
    expect(await test.receipt()).toMatchObject({ failures: [{ classification: 'audit-failed' }], outcome: 'failed' });
    expect(test.record.mock.calls[1][0]).toMatchObject({ outcome: 'failed' });
  });

  it.each(['persistence', 'completion-audit'] as const)('blocks publication on %s failure', async failure => {
    const test = await fixture();
    const error = new Error(`${failure} unavailable`);
    if (failure === 'persistence') test.put.mockRejectedValueOnce(error);
    else test.record.mockResolvedValueOnce(undefined).mockRejectedValueOnce(error);
    const publication = vi.fn();
    await expect(new LifecycleDispatcher([test.module, { name: 'publication', onBeforePublish: publication }])
      .run('before-publish', test.context)).rejects.toBe(error);
    expect(publication).not.toHaveBeenCalled();
    expect(test.record).toHaveBeenCalledTimes(2);
    if (failure === 'persistence') {
      expect(test.record.mock.calls[1][0]).toMatchObject({ outcome: 'failed', summary: expect.stringContaining('persistence-failed') });
      expect(test.record.mock.calls[1][1]?.evidence).toBeUndefined();
    } else expect(test.record.mock.calls[1][1]?.evidence).toHaveLength(1);
  });

  it('preserves verification, persistence and audit errors together', async () => {
    const providerError = new Error('provider unavailable');
    const storeError = new Error('store unavailable');
    const auditError = new Error('audit unavailable');
    const test = await fixture(reported(async () => { throw providerError; }));
    test.put.mockRejectedValueOnce(storeError);
    test.record.mockResolvedValueOnce(undefined).mockRejectedValueOnce(auditError);
    await expect(test.module.onBeforePublish!(test.context)).rejects.toMatchObject({ errors: [providerError, storeError, auditError] });
  });

  it('binds both revisions and rejects a provider that changes HEAD', async () => {
    let mutate!: () => Promise<void>;
    const test = await fixture(reported(async () => { await mutate(); return { passed: true, durationMs: 1 }; }));
    mutate = async () => {
      await test.git.commit('changed', { '--allow-empty': null });
    };
    await expect(test.module.onBeforePublish!(test.context)).rejects.toThrow('HEAD or branch changed');
    const receipt = await test.receipt();
    expect(receipt).toMatchObject({ result: { passed: true }, outcome: 'failed', revision: { before: test.before }, failures: [{ classification: 'revision-changed' }] });
    expect(receipt.revision.after).toEqual({ head: await test.git.revparse(['HEAD']), branch: await test.git.revparse(['--abbrev-ref', 'HEAD']) });
    expect(receipt.revision.after).not.toEqual(receipt.revision.before);
  });

  it.each(['request', 'result'] as const)('saves invalid %s failures and audits them', async invalid => {
    const verify = vi.fn(async () => ({ passed: true, durationMs: invalid === 'result' ? -1 : 1 }));
    const test = await fixture(reported(verify));
    if (invalid === 'request') test.request.mockReturnValue({ target: '/fake', timeoutMs: -1 });
    await expect(test.module.onBeforePublish!(test.context)).rejects.toThrow('Invalid');
    expect(verify).toHaveBeenCalledTimes(invalid === 'request' ? 0 : 1);
    expect(await test.receipt()).toMatchObject({
      outcome: 'failed', failures: [{ classification: invalid === 'request' ? 'invalid-request' : 'provider-exception' }],
    });
    expect(test.record.mock.calls[1][0]).toMatchObject({ outcome: 'failed' });
  });

  it('does not execute without a readable Git revision and persists the binding failure', async () => {
    const test = await fixture();
    const verify = vi.spyOn(test.provider, 'verify');
    await rm(join(test.root, '.git'), { recursive: true, force: true });
    await expect(test.module.onBeforePublish!(test.context)).rejects.toThrow();
    expect(verify).not.toHaveBeenCalled();
    expect(test.request).not.toHaveBeenCalled();
    expect(await test.receipt()).toMatchObject({ outcome: 'failed', failures: [{ classification: 'workspace-failed' }] });
    expect(test.record.mock.calls[0][0]).toMatchObject({ kind: 'effect.completed', outcome: 'failed' });
  });

  it('blocks publication if the Git revision cannot be reread after verification', async () => {
    let removeGit!: () => Promise<void>;
    const test = await fixture(reported(async () => { await removeGit(); return { passed: true, durationMs: 1 }; }));
    removeGit = () => rm(join(test.root, '.git'), { recursive: true, force: true });
    await expect(test.module.onBeforePublish!(test.context)).rejects.toThrow();
    expect(await test.receipt()).toMatchObject({
      outcome: 'failed', result: { passed: true }, revision: { before: test.before }, failures: [{ classification: 'revision-changed' }],
    });
    expect(test.record.mock.calls[1][0]).toMatchObject({ outcome: 'failed' });
  });

  it('does not hide persistence failure after cancellation', async () => {
    const controller = new AbortController();
    const reason = new Error('verification cancelled');
    const storageError = new Error('cancelled receipt storage failed');
    const test = await fixture(reported(async () => { controller.abort(reason); return { passed: true, durationMs: 1 }; }));
    test.put.mockRejectedValueOnce(storageError);
    await expect(test.module.onBeforePublish!({ ...test.context, signal: controller.signal }))
      .rejects.toMatchObject({ errors: [reason, storageError] });
    expect(test.put).toHaveBeenCalledTimes(1);
    expect(test.record.mock.calls[1][0]).toMatchObject({ outcome: 'failed', summary: expect.stringContaining('persistence-failed') });
  });

  it.each(['executionId', 'cwd', 'inputDigest', 'command', 'exitCode', 'passed'] as const)('rejects mismatched execution %s without granting native provenance', async field => {
    const test = await fixture(reported(async request => {
      const execution = {
        protocol: 'verification-execution-v1' as const, executionId: request.executionId!, command: request.command!, cwd: request.target,
        inputDigest: createHash('sha256').update(request.input ?? '').digest('hex'), exitCode: 0, stdout: 'claimed', stderr: '', closed: true as const,
      };
      if (field === 'executionId') execution.executionId = 'forged-id';
      if (field === 'cwd') execution.cwd = '/fake';
      if (field === 'inputDigest') execution.inputDigest = 'a'.repeat(64);
      if (field === 'command') execution.command = [node, '-e', 'process.exit(0)'];
      if (field === 'exitCode') execution.exitCode = 9;
      return { passed: field !== 'passed', durationMs: 1, execution };
    }));
    test.request.mockReturnValue({ target: '/fake', input: 'payload', command: [node, '-e', 'console.log("verified")'] });
    await expect(test.module.onBeforePublish!(test.context)).rejects.toThrow('execution mismatch');
    expect(await test.receipt()).toMatchObject({ provenance: 'provider-result', outcome: 'failed', failures: [{ classification: 'execution-mismatch' }] });
  });

  it('keeps matching schema execution as provider-result, never native proof or domain qualification', async () => {
    const test = await fixture(reported(async request => ({
      passed: true, durationMs: 1, execution: {
        protocol: 'verification-execution-v1', executionId: request.executionId!, command: request.command!, cwd: request.target,
        inputDigest: createHash('sha256').update('').digest('hex'), exitCode: 0, stdout: 'claimed', stderr: '', closed: true,
      },
    })));
    await test.module.onBeforePublish!(test.context);
    const receipt = await test.receipt();
    expect(receipt.provenance).toBe('provider-result');
    expect(receipt).not.toHaveProperty('qualification');
    expect(receipt).not.toHaveProperty('fact');
  });

  it('retains provider-reported semantics for passed-only providers and snapshots observation before provider mutation', async () => {
    let mutate!: () => void;
    const test = await fixture(reported(async () => { mutate(); return { passed: true, durationMs: 1, output: 'reported' }; }));
    const original = structuredClone(test.observed);
    mutate = () => { test.observed.actor.id = 'mutated'; test.observed.attempt = 99; };
    await test.module.onBeforePublish!(test.context);
    const receipt = await test.receipt();
    expect(receipt).toMatchObject({ provenance: 'provider-reported', observation: original, outcome: 'succeeded', result: { passed: true, output: 'reported' } });
    expect(receipt).not.toHaveProperty('qualification');
    expect(receipt).not.toHaveProperty('fact');
  });
});
