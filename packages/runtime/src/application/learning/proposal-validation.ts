import { createHash, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { z } from 'zod';
import type { ProviderOperationOptions } from '../../plugin-sdk/capabilities.js';
import { FrozenCleanupError } from '../../infrastructure/sandbox/container/frozen-execution.js';
import { RepositoryPreparationCleanupError } from '../../infrastructure/providers/repositories.js';
import type { LearningCandidate } from './candidate-store.js';
import { candidateProposalSchema, DISTILLATION_LIMITS, learningScopeSchema } from './contracts.js';
import { ProposalRuntimeCleanupError, ProposalRuntimeLeaseError, verifyRepositoryAssetProposal,
  type ProposalRuntimeObservation, type ProposalRuntimeOptions } from './proposal-runtime.js';
import { compareProposalActual, prepareAssetProposal } from './proposals.js';
import { canonicalLearningJson, learningDigestSchema, learningIdentitySchema, prepareDistillationRequest } from './requests.js';
import { observeProposalExperiment, prepareProposalExperiment } from './proposal-semantics.js';
import type { LearningValidationChecker, LearningValidationCommitSnapshot, LearningValidationDependencies, LearningValidationResult } from './validation.js';

const protocol = 'learning-validation-v1';
const inputSchema = z.object({ scope: learningScopeSchema, candidateId: learningDigestSchema,
  expectedVersion: z.number().int().positive().safe(), checkerId: learningIdentitySchema }).strict();
const targetSchema = z.object({ scope: learningScopeSchema, ref: learningIdentitySchema,
  revision: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/), snapshotDigest: learningDigestSchema }).strict();
const checkerSchema = z.object({ id: learningIdentitySchema, version: learningIdentitySchema, runtimeVersion: learningIdentitySchema,
  configurationDigest: learningDigestSchema, target: targetSchema }).strict();
const authorizationSchema = z.object({ allowed: z.boolean(), authorizationDigest: learningDigestSchema }).strict();
const sourceSchema = z.object({ current: z.boolean(), evidenceDigest: learningDigestSchema }).strict();

export interface ProposalValidationChecker extends Pick<LearningValidationChecker, 'id' | 'version' | 'configurationDigest' | 'target'> {
  runtimeVersion: string;
  runtime: Omit<ProposalRuntimeOptions, 'binding' | 'signal'>;
}

export interface ProposalValidationCommitSnapshot extends Pick<LearningValidationCommitSnapshot, 'authorization' | 'source'> {
  checker: ProposalValidationChecker;
}

export interface ProposalValidationDependencies extends Pick<LearningValidationDependencies, 'store' | 'authorize' | 'reconcile'> {
  resolveChecker(candidate: LearningCandidate, checkerId: string, options: ProviderOperationOptions): Promise<ProposalValidationChecker | undefined>;
  readCommitSnapshot(candidate: LearningCandidate, checkerId: string): ProposalValidationCommitSnapshot;
}

type ValidationCode = Extract<LearningValidationResult, { status: 'blocked' }>['code'];
class ValidationBlocked extends Error {
  constructor(readonly code: ValidationCode) { super(code); }
}
function fail(code: ValidationCode): never { throw new ValidationBlocked(code); }
const digest = (value: unknown) => createHash('sha256').update(canonicalLearningJson(value)).digest('hex');
const bytesDigest = (value: string) => createHash('sha256').update(value).digest('hex');
const same = (first: unknown, second: unknown) => canonicalLearningJson(first) === canonicalLearningJson(second);

function parseInput(input: unknown) {
  try {
    if (!input || typeof input !== 'object' || ![null, Object.prototype].includes(Object.getPrototypeOf(input))) return;
    const descriptors = Object.getOwnPropertyDescriptors(input);
    if (Reflect.ownKeys(descriptors).length !== 4 || Object.keys(inputSchema.shape).some(key =>
      !Object.hasOwn(descriptors, key) || !('value' in descriptors[key]) || !descriptors[key].enumerable)) return;
    return inputSchema.safeParse(Object.fromEntries(Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value])));
  } catch { return; }
}

function describeChecker(checker: ProposalValidationChecker) {
  const metadata = checkerSchema.parse({ id: checker.id, version: checker.version, runtimeVersion: checker.runtimeVersion,
    configurationDigest: checker.configurationDigest, target: checker.target });
  const runtime = checker.runtime;
  const repository = runtime.repository;
  const harness = runtime.harness;
  const configuration = { ...metadata, runtime: { request: runtime.request, expectedCommit: runtime.expectedCommit,
    inventory: runtime.inventory, inventoryDigest: runtime.inventoryDigest, inventoryRoot: runtime.inventoryRoot,
    artifactPath: runtime.artifactPath, baseImageId: runtime.baseImageId, repositoryId: repository.id,
    repositoryCapabilities: repository.capabilities, harness: harness && { id: harness.id, revision: harness.revision, kind: harness.kind, cases: harness.cases } } };
  const identities = [repository, repository.snapshot, repository.withLifecycleLease, repository.prepare, repository.checkout, repository.cleanup,
    runtime.sandbox, runtime.sandbox.executeFrozen, harness, harness?.observe, runtime.assertCurrent, runtime.recordOwnership];
  return { metadata, configuration: canonicalLearningJson(configuration), identities };
}

export async function validateProposalCandidate(input: unknown, dependencies: ProposalValidationDependencies,
  options: ProviderOperationOptions & { timeoutMs?: number } = {}): Promise<LearningValidationResult> {
  const began = performance.now();
  const parsed = parseInput(input);
  const timeout = z.number().int().positive().max(DISTILLATION_LIMITS.timeoutMs).safeParse(options.timeoutMs ?? DISTILLATION_LIMITS.timeoutMs);
  if (!parsed?.success || !timeout.success) return { status: 'blocked', code: 'invalid_input' };
  const request = parsed.data;
  const controller = new AbortController();
  const deadline = began + timeout.data;
  let timedOut = false;
  const cancel = () => controller.abort();
  const checkAbort = () => {
    if (timedOut || performance.now() >= deadline) { timedOut = true; cancel(); fail('timed_out'); }
    if (controller.signal.aborted) fail('cancelled');
  };
  const timer = setTimeout(() => { timedOut = true; cancel(); }, timeout.data);
  options.signal?.addEventListener('abort', cancel, { once: true });
  let rejectCancellation: () => void = () => undefined;
  const cancellation = new Promise<never>((_resolve, reject) => {
    rejectCancellation = () => reject(new ValidationBlocked(timedOut || performance.now() >= deadline ? 'timed_out' : 'cancelled'));
    controller.signal.addEventListener('abort', rejectCancellation, { once: true });
  });
  const operation = { signal: controller.signal };

  const load = () => {
    checkAbort();
    const candidate = dependencies.store.getCandidate(request.candidateId);
    if (!candidate || candidate.id !== request.candidateId) fail('candidate_unavailable');
    if (candidate.proposal.applicability.project !== request.scope) fail('scope_mismatch');
    if (candidate.version !== request.expectedVersion || candidate.state !== 'candidate') fail('stale_candidate');
    if (candidate.proposal.kind !== 'skill' && candidate.proposal.kind !== 'tool') fail('unsupported_kind');
    const proposal = candidateProposalSchema.safeParse(candidate.proposal);
    if (!proposal.success || candidate.digest !== digest(proposal.data)) fail('insufficient_evidence');
    const source = dependencies.store.getRequest(candidate.requestKey);
    if (!source || source.blockedReason || source.request.evidenceDigest !== candidate.evidenceDigest) fail('source_unavailable');
    if (source.request.scope !== request.scope) fail('scope_mismatch');
    if (prepareDistillationRequest({ request: source.request, evidence: source.evidence }).key !== candidate.requestKey
      || source.key !== candidate.requestKey || !dependencies.store.getProcessingReceipt(candidate.requestKey)?.candidateIds.includes(candidate.id)) fail('source_unavailable');
    const evidence = dependencies.store.getEvidencePack(candidate.evidenceDigest);
    if (!evidence) fail('evidence_unavailable');
    if (evidence.completeness !== 'complete') fail('insufficient_evidence');
    const refs = new Map(evidence.entries.map(entry => [entry.ref.id, entry.ref]));
    if (refs.size !== source.evidence.length || source.evidence.some(ref => !refs.has(ref.id) || !same(ref, refs.get(ref.id)))) fail('insufficient_evidence');
    if (!candidate.proposal.evidenceIds.length || candidate.proposal.evidenceIds.some(id => {
      const ref = refs.get(id);
      return !ref || ref.completeness !== 'complete' || ref.authority !== 'observed';
    })) fail('insufficient_evidence');
    const sourceRuns = new Set<string>();
    for (const provenance of evidence.sources.filter(entry => entry.kind === 'audit')) {
      let sourceRunId: string | undefined;
      const entries = evidence.entries.filter(entry => entry.position.sourceId === provenance.id);
      if (provenance.completeness !== 'complete' || !entries.length) fail('source_unavailable');
      for (const entry of entries) {
        const event = JSON.parse(entry.content);
        const identity = learningIdentitySchema.safeParse(event?.context?.runId);
        if (entry.ref.authority !== 'observed' || entry.ref.kind !== 'audit' || !identity.success
          || identity.data !== event.context.runId || identity.data.toLowerCase().includes('[redacted')
          || !Number.isSafeInteger(event.sequence) || event.sequence < 1 || event.sequence !== entry.position.auditSequence
          || (sourceRunId !== undefined && sourceRunId !== identity.data)) fail('source_unavailable');
        sourceRunId = identity.data;
        sourceRuns.add(sourceRunId);
      }
    }
    const sourceRunIds = [...sourceRuns].sort();
    if (!sourceRunIds.length || (source.request.sourceRunId !== undefined && !sourceRuns.has(source.request.sourceRunId))) fail('source_unavailable');
    return { candidate, source, evidence, sourceRunIds };
  };

  const execute = async (): Promise<LearningValidationResult> => {
    const initial = load();
    const candidate = initial.candidate;
    let authorization: z.infer<typeof authorizationSchema>;
    try { authorization = authorizationSchema.parse(await dependencies.authorize(structuredClone(candidate), operation)); }
    catch { checkAbort(); fail('unauthorized'); }
    checkAbort();
    if (!authorization.allowed) fail('unauthorized');
    try {
      const source = sourceSchema.parse(await dependencies.reconcile(structuredClone(candidate), operation));
      if (!source.current || source.evidenceDigest !== candidate.evidenceDigest) fail('source_unavailable');
    } catch { checkAbort(); fail('source_unavailable'); }
    let selected: ProposalValidationChecker;
    let pinned: ReturnType<typeof describeChecker>;
    try {
      const checker = await dependencies.resolveChecker(structuredClone(candidate), request.checkerId, operation);
      checkAbort();
      if (!checker) fail('checker_unavailable');
      selected = checker;
      pinned = describeChecker(checker);
    } catch { checkAbort(); fail('checker_unavailable'); }
    if (pinned.metadata.id !== request.checkerId) fail('checker_unavailable');
    const runtime = selected.runtime;
    const harness = runtime.harness;
    if (!harness || typeof harness.observe !== 'function' || typeof runtime.sandbox.executeFrozen !== 'function'
      || typeof runtime.assertCurrent !== 'function' || typeof runtime.recordOwnership !== 'function') fail('checker_unavailable');
    if (selected.target.scope !== request.scope || selected.target.revision !== runtime.expectedCommit
      || selected.target.ref !== runtime.request.repository.url) fail('target_mismatch');
    const runId = runtime.request.runId;
    const assertIndependentRun = (sourceRunIds = initial.sourceRunIds) => {
      if (sourceRunIds.includes(runId) || dependencies.store.listAnalysisAttempts(candidate.requestKey)
        .some(attempt => attempt.analysisRunId === runId || attempt.sessionId === runId)) fail('target_mismatch');
    };
    assertIndependentRun();
    let prepared: ReturnType<typeof prepareAssetProposal>;
    try { prepared = prepareAssetProposal(candidate.proposal, runtime.inventory); }
    catch { fail('verification_failed'); }
    const runtimeBinding = { scope: request.scope, candidateId: candidate.id, candidateVersion: candidate.version, evidenceDigest: candidate.evidenceDigest };
    const guard = () => {
      checkAbort();
      let snapshot: ProposalValidationCommitSnapshot;
      let current: ReturnType<typeof describeChecker>;
      let grant: z.infer<typeof authorizationSchema>;
      let source: z.infer<typeof sourceSchema>;
      try {
        snapshot = dependencies.readCommitSnapshot(structuredClone(candidate), request.checkerId);
        if (!snapshot) fail('commit_guard_unavailable');
        if (typeof (snapshot as unknown as { then?: unknown }).then === 'function') {
          void Promise.resolve(snapshot).catch(() => undefined);
          fail('commit_guard_unavailable');
        }
        grant = authorizationSchema.parse(snapshot.authorization);
        source = sourceSchema.parse(snapshot.source);
        current = describeChecker(snapshot.checker);
      } catch { checkAbort(); fail('commit_guard_unavailable'); }
      if (!grant.allowed) fail('unauthorized');
      if (!same(grant, authorization)) fail('authorization_changed');
      if (!source.current || source.evidenceDigest !== candidate.evidenceDigest) fail('source_unavailable');
      if (!same(current.metadata.target, pinned.metadata.target)) fail('target_mismatch');
      if (current.configuration !== pinned.configuration || current.identities.some((identity, index) => identity !== pinned.identities[index])) fail('checker_changed');
      const loaded = load();
      assertIndependentRun(loaded.sourceRunIds);
      if (!same(loaded, initial)) fail('stale_candidate');
      try { if (!same(prepareAssetProposal(candidate.proposal, snapshot.checker.runtime.inventory), prepared)) fail('target_mismatch'); }
      catch { fail('target_mismatch'); }
      checkAbort();
    };
    guard();
    const assertCurrent = runtime.assertCurrent.bind(runtime);
    const executionOptions: ProposalRuntimeOptions = { ...runtime, binding: runtimeBinding, signal: controller.signal,
      inventory: structuredClone(runtime.inventory), request: structuredClone(runtime.request),
      harness: { ...harness, cases: structuredClone(harness.cases), observe: harness.observe.bind(harness) },
      sandbox: { executeFrozen: runtime.sandbox.executeFrozen.bind(runtime.sandbox) },
      recordOwnership: runtime.recordOwnership.bind(runtime),
      async assertCurrent(binding, active) { guard(); await assertCurrent(binding, active); guard(); } };
    let result: Awaited<ReturnType<typeof verifyRepositoryAssetProposal>>;
    try { result = await verifyRepositoryAssetProposal(prepared, executionOptions); }
    catch (error) {
      if (error instanceof ValidationBlocked) throw error;
      if (error instanceof FrozenCleanupError || error instanceof ProposalRuntimeCleanupError || error instanceof ProposalRuntimeLeaseError
        || error instanceof RepositoryPreparationCleanupError) fail('storage_failed');
      checkAbort(); fail('verification_failed');
    }
    guard();
    if (result.status === 'blocked') fail(result.code === 'oracle_unsupported' ? 'insufficient_coverage' : 'checker_unavailable');
    if (result.assurance !== 'docker-frozen-image' || result.cleanup.removed !== true || !same(result.binding, runtimeBinding)
      || !learningDigestSchema.safeParse(result.configurationDigest).success) fail('binding_mismatch');
    if (result.comparisons.length !== prepared.checks.length || new Set(result.comparisons.map(comparison => comparison.checkId)).size !== prepared.checks.length) fail('insufficient_coverage');
    const operations = new Set<string>();
    let nonAssetDigest: string | undefined;
    for (const check of prepared.checks) {
      const comparison = result.comparisons.find(entry => entry.checkId === check.id);
      const configured = executionOptions.harness!.cases.find(entry => entry.checkId === check.id);
      if (!comparison || !configured || configured.checkDigest !== digest(check) || !comparison.proposed
        || Boolean(comparison.original) !== Boolean(prepared.artifact.originalDigest)) fail('insufficient_coverage');
      for (const version of ['original', 'proposed'] as const) {
        const observation: ProposalRuntimeObservation | undefined = comparison[version];
        if (!observation) continue;
        const { receipt, execution } = observation;
        const binding = receipt.binding;
        const expected = { ...runtimeBinding, repositoryId: runtime.repository.id, runId: executionOptions.request.runId,
          commit: executionOptions.expectedCommit, repositoryDigest: digest(executionOptions.request.repository), inventoryDigest: digest(executionOptions.inventory),
          configurationDigest: result.configurationDigest, proposalDigest: candidate.digest, artifactPath: executionOptions.artifactPath,
          artifactDigest: version === 'original' ? prepared.artifact.originalDigest : prepared.artifact.digest, version,
          checkId: check.id, checkDigest: digest(check), inputDigest: bytesDigest(check.input), oracleId: executionOptions.harness!.id,
          oracleRevision: executionOptions.harness!.revision, expectedDigest: digest(configured.expected), baseImageId: executionOptions.baseImageId };
        if (observation.receiptDigest !== digest(receipt) || Object.entries(expected).some(([key, value]) => !same(binding[key as keyof typeof binding], value))
          || !learningIdentitySchema.safeParse(binding.workspaceId).success || !learningDigestSchema.safeParse(binding.nonAssetDigest).success
          || binding.executionDigest !== digest(execution) || binding.operationId !== execution.evidence.operationId
          || binding.imageId !== execution.evidence.imageId || binding.contextDigest !== execution.evidence.contextDigest
          || binding.inputTreeDigest !== execution.evidence.inputDigest || binding.commandDigest !== execution.evidence.commandDigest
          || binding.policyDigest !== execution.evidence.policyDigest || binding.cwd !== '/workspace' || !same(binding.argv, execution.evidence.argv)
          || operations.has(binding.operationId) || (nonAssetDigest !== undefined && binding.nonAssetDigest !== nonAssetDigest)) fail('binding_mismatch');
        operations.add(binding.operationId);
        nonAssetDigest = binding.nonAssetDigest;
        if (!same(receipt.expected, configured.expected) || !Number.isSafeInteger(receipt.assertions) || receipt.assertions < 1) fail('invalid_receipt');
        let passed = execution.exitCode === 0 && compareProposalActual(receipt.actual, configured.expected);
        if (configured.experiment !== undefined) {
          if (!receipt.semantic) fail('insufficient_coverage');
          const semanticExperiment = prepareProposalExperiment(prepared.kind, executionOptions.artifactPath, check, configured.experiment);
          if (semanticExperiment.status !== 'prepared') fail('insufficient_coverage');
          const semantic = observeProposalExperiment(semanticExperiment.experiment, execution);
          if (!same(receipt.semantic, semantic) || !same(receipt.actual, semantic.assertions) || receipt.assertions !== semantic.assertions.length) fail('invalid_receipt');
          passed = semantic.passed;
        } else if (receipt.semantic !== undefined) fail('invalid_receipt');
        if (receipt.passed !== passed) fail('invalid_receipt');
        if (version === 'proposed' && !passed) fail('assertion_failed');
      }
    }
    const executionId = randomUUID();
    const observations = result.comparisons.flatMap(comparison => comparison.original ? [comparison.original, comparison.proposed] : [comparison.proposed]);
    const observationBinding = Object.fromEntries(Object.entries(observations[0].receipt.binding).filter(([key, value]) =>
      observations.every(observation => same(observation.receipt.binding[key as keyof typeof observation.receipt.binding], value))));
    const packObservation = (observation: ProposalRuntimeObservation) => ({ receipt: { ...observation.receipt,
      binding: Object.fromEntries(Object.entries(observation.receipt.binding).filter(([key]) => !Object.hasOwn(observationBinding, key))) },
      receiptDigest: observation.receiptDigest });
    const report = { protocol, binding: { ...runtimeBinding, executionId, candidateDigest: candidate.digest, requestDigest: digest(initial.source),
      sourceRunIds: initial.sourceRunIds,
      checkerId: pinned.metadata.id, checkerVersion: pinned.metadata.version, runtimeVersion: pinned.metadata.runtimeVersion,
      configurationDigest: pinned.metadata.configurationDigest,
      authorizationDigest: authorization.authorizationDigest, target: pinned.metadata.target, runtimeDigest: bytesDigest(pinned.configuration),
      runtimeConfigurationDigest: result.configurationDigest }, observationBinding,
      comparisons: result.comparisons.map(comparison => ({ checkId: comparison.checkId,
        original: comparison.original && packObservation(comparison.original), proposed: packObservation(comparison.proposed) })) };
    const receiptDigest = digest(report);
    const audit = canonicalLearningJson({ report, receiptDigest });
    if (Buffer.byteLength(audit) > DISTILLATION_LIMITS.outputBytes) fail('output_limit');
    const results = Buffer.from(audit).toString('base64').match(/.{1,1800}/g)!.map(chunk => `json-base64-v1:${chunk}`);
    if (results.length > 32) fail('output_limit');
    guard();
    try {
      const validated = dependencies.store.recordValidation(candidate.id, candidate.version, { candidateDigest: candidate.digest,
        evidenceDigest: candidate.evidenceDigest, validatorVersion: `${protocol}:${executionId}`, passed: true, results }, guard);
      return { status: 'validated', candidateId: candidate.id, candidateVersion: candidate.version, validatedVersion: validated.version, executionId, receiptDigest };
    } catch (error) {
      if (error instanceof ValidationBlocked) throw error;
      checkAbort();
      if (!same(dependencies.store.getCandidate(candidate.id), candidate)) fail('stale_candidate');
      fail('storage_failed');
    }
  };
  try {
    if (options.signal?.aborted) cancel();
    return await Promise.race([execute(), cancellation]);
  } catch (error) {
    return { status: 'blocked', code: error instanceof ValidationBlocked ? error.code : 'storage_failed' };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', cancel);
    controller.signal.removeEventListener('abort', rejectCancellation);
  }
}
