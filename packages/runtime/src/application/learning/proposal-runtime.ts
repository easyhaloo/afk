import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { z } from 'zod';
import type { ProviderOperationOptions, RepositoryPrepareRequest, RepositoryProvider, RepositoryWorkspace } from '../../plugin-sdk/capabilities.js';
import { buildFrozenContext, captureFrozenInput, replaceFrozenFile, type CapturedFrozenInput } from '../../infrastructure/sandbox/container/frozen-input.js';
import { FrozenCleanupError, type FrozenExecutionOptions, type FrozenExecutionOwnership, type FrozenExecutionResult } from '../../infrastructure/sandbox/container/frozen-execution.js';
import { canonicalLearningJson, learningDigestSchema, learningIdentitySchema } from './requests.js';
import { DISTILLATION_LIMITS, learningScopeSchema } from './contracts.js';
import { compareProposalActual, prepareAssetProposal, type PreparedAssetProposal, type ProposalInventory } from './proposals.js';

const bindingSchema = z.object({ scope: learningScopeSchema, candidateId: learningDigestSchema,
  candidateVersion: z.number().int().positive().safe(), evidenceDigest: learningDigestSchema }).strict();
const ownershipSchema = z.object({ operationId: z.string().uuid(), engine: z.literal('docker'), containerName: learningIdentitySchema,
  baseImageId: z.string().regex(/^sha256:[a-f0-9]{64}$/), inputDigest: learningDigestSchema, contextDigest: learningDigestSchema }).strict();
export type ProposalRuntimeBinding = z.infer<typeof bindingSchema>;

export interface ProposalRuntimeCase {
  checkId: string;
  checkDigest: string;
  argv: string[];
  expected: unknown;
}

export interface ProposalRuntimeHarness {
  id: string;
  revision: string;
  kind: 'skill' | 'tool';
  cases: ProposalRuntimeCase[];
  observe(result: Readonly<FrozenExecutionResult>, check: Readonly<ProposalRuntimeCase>, options: ProviderOperationOptions):
    Promise<{ status: 'observed'; actual: unknown; assertions: number } | { status: 'unsupported'; reason: string }>;
}

export interface ProposalRuntimeOptions extends ProviderOperationOptions {
  repository: RepositoryProvider;
  request: RepositoryPrepareRequest;
  expectedCommit: string;
  inventory: ProposalInventory;
  inventoryDigest?: string;
  inventoryRoot?: string;
  artifactPath: string;
  baseImageId: string;
  binding: ProposalRuntimeBinding;
  sandbox: { executeFrozen(options: FrozenExecutionOptions): Promise<FrozenExecutionResult> };
  harness?: ProposalRuntimeHarness;
  assertCurrent(binding: Readonly<ProposalRuntimeBinding>, options: ProviderOperationOptions): Promise<void>;
  recordOwnership(ownership: FrozenExecutionOwnership, binding: Readonly<ProposalRuntimeBinding>,
    check: { checkId: string; checkDigest: string; version: 'original' | 'proposed'; configurationDigest: string;
      commit: string; inventoryDigest: string; artifactDigest: string; artifactPath: string; workspaceId: string; runId: string }): Promise<void>;
}

export interface ProposalRuntimeObservation {
  execution: FrozenExecutionResult;
  receipt: {
    version: 1;
    binding: ProposalRuntimeBinding & { repositoryId: string; workspaceId: string; runId: string; commit: string; repositoryDigest: string;
      inventoryDigest: string; configurationDigest: string; proposalDigest: string; artifactPath: string; artifactDigest: string;
      nonAssetDigest: string; version: 'original' | 'proposed'; checkId: string; checkDigest: string; inputDigest: string;
      oracleId: string; oracleRevision: string; expectedDigest: string; operationId: string; imageId: string;
      baseImageId: string; contextDigest: string; executionDigest: string; argv: readonly string[];
      inputTreeDigest: string; commandDigest: string; policyDigest: string; cwd: '/workspace' };
    actual: unknown;
    expected: unknown;
    assertions: number;
    passed: boolean;
  };
  receiptDigest: string;
}

type Comparison = { checkId: string; original?: ProposalRuntimeObservation; proposed: ProposalRuntimeObservation };
export type ProposalRuntimeResult = { status: 'blocked'; code: 'oracle_unavailable' | 'oracle_unsupported' | 'repository_unavailable'; observations: ProposalRuntimeObservation[];
  unverified?: { checkId: string; checkDigest: string; version: 'original' | 'proposed'; execution: FrozenExecutionResult; reason: string;
    binding: ProposalRuntimeObservation['receipt']['binding']; receiptDigest: string } }
  | { status: 'verification-observed'; assurance: 'docker-frozen-image'; comparisons: Comparison[];
    cleanup: { removed: true }; binding: ProposalRuntimeBinding; configurationDigest: string };

export class ProposalRuntimeCleanupError extends AggregateError {
  constructor(readonly workspaceId: string, errors: unknown[], cause: unknown) {
    super(errors, 'Proposal repository cleanup could not be confirmed', { cause });
  }
}

export class ProposalRuntimeLeaseError extends AggregateError {
  constructor(readonly runId: string, readonly workspaceId: string | undefined, errors: unknown[], cause: unknown) {
    super(errors, 'Proposal repository lease completion could not be confirmed', { cause });
  }
}

type ProposalOperationOutcome = { failed: true; error: unknown } | { failed: false; value: ProposalRuntimeResult };

function proposalFailure(error: unknown, signal: AbortSignal): unknown {
  if (error instanceof FrozenCleanupError || error instanceof ProposalRuntimeCleanupError || error instanceof ProposalRuntimeLeaseError) return error;
  return signal.aborted ? signal.reason : error;
}

const digest = (value: unknown) => createHash('sha256').update(canonicalLearningJson(value)).digest('hex');
const bytesDigest = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const checkAbort = (signal?: AbortSignal) => { if (signal?.aborted) throw signal.reason; };
function freezeJson<Value>(value: Value): Value {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freezeJson(child); Object.freeze(value); }
  return value;
}

async function git(workspace: string, args: string[], signal?: AbortSignal): Promise<Buffer> {
  checkAbort(signal);
  const environment = { ...process.env };
  for (const name of Object.keys(environment)) if (name.startsWith('GIT_')) delete environment[name];
  Object.assign(environment, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_NO_REPLACE_OBJECTS: '1' });
  return new Promise((accept, reject) => {
    execFile('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', '-C', workspace, ...args],
      { encoding: 'buffer', env: environment, maxBuffer: 9 * 1024 * 1024, timeout: 15_000, killSignal: 'SIGKILL', signal }, (error, stdout) => {
        if (signal?.aborted) reject(signal.reason);
        else if (error) reject(error);
        else accept(stdout);
      });
  });
}

async function captureCommitted(workspace: RepositoryWorkspace, commit: string, artifactPath: string, originalDigest: string | null,
  signal?: AbortSignal): Promise<CapturedFrozenInput> {
  const root = workspace.path!;
  const text = async (args: string[]) => (await git(root, args, signal)).toString('utf8').trim();
  if (await text(['rev-parse', '--show-toplevel']) !== root || await text(['rev-parse', 'HEAD']) !== commit
    || (await git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored=matching'], signal)).length) {
    throw new Error('Proposal requires a clean committed Git workspace without ignored inputs');
  }
  if (await text(['cat-file', '-t', commit]) !== 'commit') throw new Error('Proposal baseline must be a Git commit');
  const objectFormat = await text(['rev-parse', '--show-object-format']);
  if (!['sha1', 'sha256'].includes(objectFormat)) throw new Error('Unsupported Git object format');
  const tree = (await git(root, ['ls-tree', '-r', '-z', '--full-tree', commit], signal)).toString('utf8').split('\0').filter(Boolean);
  if (tree.length > 1024) throw new Error('Proposal committed input exceeds entry limit');
  const expected = new Map<string, { mode: number; digest: string; size: number }>();
  const directories = new Set<string>();
  let total = 0;
  for (const item of tree) {
    const entry = /^(100644|100755) blob ([a-f0-9]{40}|[a-f0-9]{64})\t([^\0]+)$/.exec(item);
    if (!entry) throw new Error('Proposal commit contains an unsupported input type');
    const [, mode, object, path] = entry;
    if (path.split('/').some(part => !part || part === '..' || part === '.' || part === '.git')) throw new Error('Unsafe committed proposal path');
    const content = await git(root, ['cat-file', 'blob', object], signal);
    total += content.length;
    if (total > 8 * 1024 * 1024) throw new Error('Proposal committed input exceeds byte limit');
    const actualObject = createHash(objectFormat).update(`blob ${content.length}\0`).update(content).digest('hex');
    if (actualObject !== object) throw new Error('Proposal Git object identity differs from committed bytes');
    expected.set(path, { mode: mode === '100755' ? 0o555 : 0o444, digest: bytesDigest(content), size: content.length });
    let parent = path.lastIndexOf('/');
    while (parent >= 0) { directories.add(path.slice(0, parent)); parent = path.lastIndexOf('/', parent - 1); }
  }
  const input = captureFrozenInput(root, { signal });
  if (input.manifest.length !== expected.size + directories.size) throw new Error('Proposal captured tree differs from committed inventory');
  for (const entry of input.manifest) {
    if (entry.kind === 'directory') { if (!directories.has(entry.path)) throw new Error('Proposal captured an uncommitted directory'); continue; }
    const target = expected.get(entry.path);
    if (!target || entry.digest !== target.digest || entry.mode !== target.mode || entry.size !== target.size) throw new Error('Proposal captured bytes or mode differ from commit');
  }
  if (originalDigest ? expected.get(artifactPath)?.digest !== originalDigest : expected.has(artifactPath)) throw new Error('Proposal inventory artifact differs from committed baseline');
  if (await text(['rev-parse', 'HEAD']) !== commit) throw new Error('Proposal baseline changed during capture');
  checkAbort(signal);
  return input;
}

export async function verifyRepositoryAssetProposal(input: PreparedAssetProposal, supplied: ProposalRuntimeOptions): Promise<ProposalRuntimeResult> {
  const controller = new AbortController();
  const sourceSignal = supplied.signal;
  const propagate = () => {
    if (controller.signal.aborted) return;
    const reason = sourceSignal?.reason;
    Object.defineProperty(controller.signal, 'reason', { value: reason, configurable: true });
    controller.abort(reason);
  };
  sourceSignal?.addEventListener('abort', propagate, { once: true });
  if (sourceSignal?.aborted) propagate();
  try { return await runRepositoryAssetProposal(input, { ...supplied, signal: controller.signal }); }
  catch (error) { throw proposalFailure(error, controller.signal); }
  finally { sourceSignal?.removeEventListener('abort', propagate); }
}

async function runRepositoryAssetProposal(input: PreparedAssetProposal, supplied: ProposalRuntimeOptions & { signal: AbortSignal }): Promise<ProposalRuntimeResult> {
  checkAbort(supplied.signal);
  const prepared: PreparedAssetProposal = freezeJson(JSON.parse(canonicalLearningJson(input)));
  const binding = freezeJson(bindingSchema.parse(supplied.binding));
  if (binding.scope !== prepared.proposal.applicability.project) throw new Error('Proposal scope differs from candidate binding');
  const inventory: ProposalInventory = freezeJson(JSON.parse(canonicalLearningJson(supplied.inventory)));
  const inventoryDigest = digest(inventory);
  if (supplied.inventoryDigest !== undefined && supplied.inventoryDigest !== inventoryDigest) throw new Error('Proposal inventory binding changed');
  if (canonicalLearningJson(prepareAssetProposal(prepared.proposal, inventory)) !== canonicalLearningJson(prepared)) throw new Error('Prepared proposal differs from current inventory or candidate');
  const repository = supplied.repository;
  const request = freezeJson({ repository: { ...supplied.request.repository }, runId: supplied.request.runId });
  learningIdentitySchema.parse(request.runId);
  const commit = supplied.expectedCommit;
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit)) throw new Error('Proposal requires an exact committed baseline');
  const artifactPath = supplied.artifactPath;
  if (!artifactPath || isAbsolute(artifactPath) || artifactPath.includes('\\') || artifactPath.split('/').some(part => !part || ['.', '..', '.git'].includes(part))) throw new Error('Unsafe configured proposal artifact path');
  const source = prepared.kind === 'skill' ? inventory.skills.find(entry => `skill:${entry.name}` === prepared.artifact.targetRef)?.source
    : inventory.tools.find(entry => entry.ref === prepared.artifact.targetRef)?.source;
  const inventoryRoot = supplied.inventoryRoot ?? source?.root;
  if (inventoryRoot !== undefined && (resolve(inventoryRoot) !== inventoryRoot || realpathSync(inventoryRoot) !== inventoryRoot)) throw new Error('Proposal inventory root must be canonical');
  if (prepared.artifact.originalDigest && (!source || !inventoryRoot || relative(inventoryRoot, realpathSync(source.file)) !== artifactPath)) {
    throw new Error('Configured artifact path differs from inventory source');
  }
  const configured = supplied.harness;
  if (!configured || configured.kind !== prepared.kind || typeof configured.observe !== 'function'
    || configured.cases.length !== prepared.checks.length || !configured.id || !configured.revision) {
    return { status: 'blocked', code: 'oracle_unavailable', observations: [] };
  }
  learningIdentitySchema.parse(configured.id);
  learningIdentitySchema.parse(configured.revision);
  for (const check of configured.cases) compareProposalActual(check.expected, check.expected);
  const cases: ProposalRuntimeCase[] = freezeJson(JSON.parse(canonicalLearningJson(configured.cases)));
  if (new Set(cases.map(entry => entry.checkId)).size !== cases.length || prepared.checks.some(check => !cases.some(entry => entry.checkId === check.id && entry.checkDigest === digest(check)))) {
    return { status: 'blocked', code: 'oracle_unavailable', observations: [] };
  }
  for (const check of cases) {
    compareProposalActual(check.expected, check.expected);
    if (!Array.isArray(check.argv) || !check.argv[0]?.trim() || check.argv.length > 128 || check.argv.some(argument => typeof argument !== 'string' || argument.includes('\0'))
      || Buffer.byteLength(canonicalLearningJson(check.argv)) > 32 * 1024) throw new Error('Invalid configured proposal command');
  }
  const harness = { id: configured.id, revision: configured.revision, observe: configured.observe.bind(configured) };
  const baseImageId = supplied.baseImageId;
  if (!/^sha256:[a-f0-9]{64}$/.test(baseImageId)) throw new Error('Proposal requires an exact local frozen image');
  if (!repository.withLifecycleLease || !repository.capabilities.read || !repository.capabilities.prepare || !repository.capabilities.checkout
    || !repository.capabilities.cleanup || !repository.prepare || !repository.checkout || !repository.cleanup) {
    return { status: 'blocked', code: 'repository_unavailable', observations: [] };
  }
  if (typeof supplied.assertCurrent !== 'function' || typeof supplied.recordOwnership !== 'function') throw new Error('Proposal requires current binding and ownership sinks');
  const repositoryId = repository.id;
  learningIdentitySchema.parse(repositoryId);
  const lease = repository.withLifecycleLease.bind(repository);
  const snapshotRepository = repository.snapshot.bind(repository);
  const prepare = repository.prepare.bind(repository);
  const checkout = repository.checkout.bind(repository);
  const cleanupWorkspace = repository.cleanup.bind(repository);
  const signal = supplied.signal;
  const assertCurrent = supplied.assertCurrent;
  const recordOwnership = supplied.recordOwnership;
  const executeFrozen = supplied.sandbox.executeFrozen.bind(supplied.sandbox);
  const configurationDigest = digest({ repositoryId, request, commit, artifactPath, baseImageId, inventoryDigest, inventoryRoot,
    binding, harnessId: harness.id, harnessRevision: harness.revision, cases, proposal: prepared });
  const current = async () => { checkAbort(signal); await assertCurrent(binding, { signal }); checkAbort(signal); };
  await current();
  const operationState: { outcome?: ProposalOperationOutcome; workspaceId?: string } = {};
  const operation = async () => {
    await current();
    const snapshot = await snapshotRepository({ url: request.repository.url }, { signal });
    checkAbort(signal);
    if (snapshot.dirty || snapshot.commit !== commit || (request.repository.ref !== undefined && snapshot.branch !== request.repository.ref)) {
      throw new Error('Configured repository baseline is dirty or changed');
    }
    let workspace = await prepare(request, {});
    const ownedId = workspace.id;
    operationState.workspaceId = ownedId;
    let failure: unknown;
    let failed = false;
    let value: ProposalRuntimeResult | undefined;
    try {
      const assertWorkspace = (next: RepositoryWorkspace) => {
        if (!ownedId || next.id !== ownedId || next.runId !== request.runId || !next.path || resolve(next.path) !== next.path || realpathSync(next.path) !== next.path
          || canonicalLearningJson(next.repository) !== canonicalLearningJson(request.repository) || next.snapshot.dirty || next.snapshot.commit !== commit) {
          throw new Error('Proposal repository workspace ownership or baseline changed');
        }
      };
      checkAbort(signal);
      assertWorkspace(workspace);
      const preparedPath = workspace.path;
      workspace = await checkout({ workspaceId: ownedId }, {});
      checkAbort(signal);
      assertWorkspace(workspace);
      if (workspace.path !== preparedPath) throw new Error('Proposal checkout relocated the owned workspace');
      const original = await captureCommitted(workspace, commit, artifactPath, prepared.artifact.originalDigest, signal);
      const proposed = replaceFrozenFile(original, artifactPath, Buffer.from(prepared.artifact.content, 'utf8'));
      const nonAssetDigest = digest(original.manifest.filter(entry => entry.path !== artifactPath));
      if (digest(proposed.manifest.filter(entry => entry.path !== artifactPath)) !== nonAssetDigest) throw new Error('Proposal variants changed non-asset bytes');
      const observations: ProposalRuntimeObservation[] = [];
      const comparisons: Comparison[] = [];
      const operationIds = new Set<string>();
      let unsupported = false;
      let unverified: Extract<ProposalRuntimeResult, { status: 'blocked' }>['unverified'];
      const observe = async (check: ProposalRuntimeCase, version: 'original' | 'proposed') => {
        await current();
        const captured = version === 'original' ? original : proposed;
        const registration: { ownership?: FrozenExecutionOwnership; recorded: boolean } = { recorded: false };
        const execution = freezeJson(await executeFrozen({ input: captured, baseImageId, argv: check.argv, timeoutMs: prepared.execution.timeoutMs,
          maxOutputBytes: DISTILLATION_LIMITS.outputBytes, signal,
          onOwnership: async ownership => {
            await current();
            const claimed = freezeJson(ownershipSchema.parse(ownership));
            if (registration.ownership || operationIds.has(claimed.operationId) || claimed.baseImageId !== baseImageId
              || claimed.inputDigest !== captured.digest || claimed.containerName !== `afk-frozen-${claimed.operationId}`
              || claimed.contextDigest !== buildFrozenContext(captured, baseImageId, claimed.operationId).digest) {
              throw new Error('Frozen ownership registration differs from this case or reuses an operation');
            }
            registration.ownership = claimed;
            operationIds.add(claimed.operationId);
            await recordOwnership(claimed, binding, { checkId: check.checkId, checkDigest: check.checkDigest,
              version, configurationDigest, commit, inventoryDigest, artifactDigest: version === 'original' ? prepared.artifact.originalDigest! : prepared.artifact.digest,
              artifactPath, workspaceId: ownedId, runId: workspace.runId });
            registration.recorded = true;
            await current();
          } }));
        checkAbort(signal);
        if (!registration.recorded || !registration.ownership || execution.evidence.operationId !== registration.ownership.operationId
          || execution.evidence.contextDigest !== registration.ownership.contextDigest) throw new Error('Frozen evidence differs from recorded ownership registration');
        if (execution.evidence.mechanism !== 'docker-frozen-image' || execution.evidence.inputDigest !== captured.digest || execution.evidence.baseImageId !== baseImageId
          || execution.evidence.cwd !== '/workspace' || canonicalLearningJson(execution.evidence.argv) !== canonicalLearningJson([
            '/usr/bin/env', '-i', 'PATH=/usr/local/bin:/usr/bin:/bin', 'HOME=/scratch', 'TMPDIR=/scratch', ...check.argv])
          || !execution.cleanup.containerRemoved || !execution.cleanup.imageRemoved) throw new Error('Frozen evidence differs from configured proposal execution');
        const candidateCheck = prepared.checks.find(entry => entry.id === check.checkId)!;
        const receiptBinding: ProposalRuntimeObservation['receipt']['binding'] = freezeJson({ ...binding, repositoryId,
          workspaceId: ownedId, runId: workspace.runId, commit, repositoryDigest: digest(workspace.repository), inventoryDigest, configurationDigest,
          proposalDigest: digest(prepared.proposal), artifactPath, artifactDigest: version === 'original' ? prepared.artifact.originalDigest! : prepared.artifact.digest,
          nonAssetDigest, version, checkId: check.checkId, checkDigest: check.checkDigest, inputDigest: bytesDigest(candidateCheck.input),
          oracleId: harness.id, oracleRevision: harness.revision, expectedDigest: digest(check.expected), operationId: execution.evidence.operationId,
          imageId: execution.evidence.imageId, baseImageId, contextDigest: execution.evidence.contextDigest, executionDigest: digest(execution), argv: execution.evidence.argv,
          inputTreeDigest: execution.evidence.inputDigest, commandDigest: execution.evidence.commandDigest,
          policyDigest: execution.evidence.policyDigest, cwd: execution.evidence.cwd });
        const actual = await harness.observe(execution, check, { signal });
        await current();
        if (actual.status === 'unsupported') {
          learningIdentitySchema.parse(actual.reason);
          unverified = { checkId: check.checkId, checkDigest: check.checkDigest, version, execution, reason: actual.reason,
            binding: receiptBinding, receiptDigest: digest({ status: 'unsupported', binding: receiptBinding, reason: actual.reason }) };
          unsupported = true;
          return undefined;
        }
        if (!Number.isSafeInteger(actual.assertions) || actual.assertions < 1) throw new Error('Proposal oracle requires actual business assertions');
        const passed = compareProposalActual(actual.actual, check.expected) && execution.exitCode === 0;
        const receipt: ProposalRuntimeObservation['receipt'] = freezeJson({ version: 1, binding: receiptBinding, actual: JSON.parse(canonicalLearningJson(actual.actual)),
          expected: check.expected, assertions: actual.assertions, passed });
        const observation = { execution, receipt, receiptDigest: digest(receipt) };
        observations.push(observation);
        return observation;
      };
      for (const check of cases) {
        const baseline = prepared.artifact.originalDigest ? await observe(check, 'original') : undefined;
        if (unsupported) break;
        const changed = await observe(check, 'proposed');
        if (unsupported || !changed) break;
        comparisons.push({ checkId: check.checkId, original: baseline, proposed: changed });
      }
      await current();
      value = unsupported ? { status: 'blocked', code: 'oracle_unsupported', observations, unverified }
        : { status: 'verification-observed', assurance: 'docker-frozen-image', comparisons, cleanup: { removed: true }, binding, configurationDigest };
    } catch (error) { failure = error instanceof FrozenCleanupError ? error : signal.aborted ? signal.reason : error; failed = true; }
    const cleanupController = new AbortController();
    const cleanupTimer = setTimeout(() => cleanupController.abort(new Error('Proposal repository cleanup timed out')), 15_000);
    try {
      const cleanup = await cleanupWorkspace({ workspaceId: ownedId }, { signal: cleanupController.signal });
      if (!cleanup.removed) throw new Error('Proposal repository cleanup refused');
    } catch (error) {
      throw new ProposalRuntimeCleanupError(ownedId, failed ? [failure, error] : signal.aborted ? [signal.reason, error] : [error],
        signal.aborted ? signal.reason : failed ? failure : error);
    }
    finally { clearTimeout(cleanupTimer); }
    if (failed) throw failure;
    checkAbort(signal);
    await current();
    return value!;
  };
  try {
    await lease(request, async () => {
      try { operationState.outcome = { failed: false, value: await operation() }; }
      catch (error) { operationState.outcome = { failed: true, error: proposalFailure(error, signal) }; }
    }, { signal });
  } catch (error) {
    const outcome = operationState.outcome;
    if (outcome) {
      throw new ProposalRuntimeLeaseError(request.runId, operationState.workspaceId, outcome.failed ? [outcome.error, error] : [error],
        outcome.failed ? outcome.error : signal.aborted ? signal.reason : error);
    }
    throw error;
  }
  const outcome = operationState.outcome;
  if (!outcome) throw new Error('Proposal repository lease returned without completing its operation');
  if (outcome.failed) throw outcome.error;
  await current();
  return outcome.value;
}
