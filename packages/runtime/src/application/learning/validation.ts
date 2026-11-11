import { createHash, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { z } from 'zod';
import type { ProviderOperationOptions, VerificationProvider, VerificationResult } from '../../plugin-sdk/capabilities.js';
import type { CandidateStore, LearningCandidate } from './candidate-store.js';
import { candidateProposalSchema, DISTILLATION_LIMITS, learningScopeSchema } from './contracts.js';
import { canonicalLearningJson, learningDigestSchema, learningIdentitySchema } from './requests.js';
import { verifyLessonQaEvidence, type LessonQaConfiguration, type LessonQaBlockedCode, type LessonQaEvidenceResult } from './lesson-validation.js';

const protocol = 'learning-validation-v1';
const inputSchema = z.object({ scope: learningScopeSchema, candidateId: learningDigestSchema,
  expectedVersion: z.number().int().positive().safe(), checkerId: learningIdentitySchema }).strict();
const targetSchema = z.object({ scope: learningScopeSchema, ref: learningIdentitySchema,
  revision: learningIdentitySchema, snapshotDigest: learningDigestSchema }).strict();
export const lessonQaConfigurationSchema = z.object({ scope: learningScopeSchema, workItemId: learningIdentitySchema,
  runId: learningIdentitySchema, targetRevision: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
  root: z.string().min(1).max(4096), auditDigest: learningDigestSchema }).strict();
const checkerSchema = z.object({ id: learningIdentitySchema, version: learningIdentitySchema,
  configurationDigest: learningDigestSchema, mode: z.literal('independent-assertions'), target: targetSchema,
  qa: lessonQaConfigurationSchema.optional() }).strict();
const authorizationSchema = z.object({ allowed: z.boolean(), authorizationDigest: learningDigestSchema }).strict();
const reconciliationSchema = z.object({ current: z.boolean(), evidenceDigest: learningDigestSchema }).strict();
const valueSchema = z.union([z.string().max(4096), z.array(z.string().max(1024)).max(64)]);
const referenceSchema = z.object({ id: learningIdentitySchema, digest: learningDigestSchema, locator: learningIdentitySchema }).strict();
const assertionSchema = z.object({ node: learningIdentitySchema, expected: valueSchema, actual: valueSchema,
  status: z.enum(['observed', 'unknown', 'inferred']), evidence: z.array(referenceSchema).min(1).max(64) }).strict();
const reportSchema = z.object({ protocol: z.literal(protocol), binding: z.unknown(),
  assertions: z.array(assertionSchema).max(100) }).strict();

export interface LearningValidationChecker {
  id: string;
  version: string;
  configurationDigest: string;
  mode: 'independent-assertions';
  target: z.infer<typeof targetSchema>;
  provider: VerificationProvider;
  qa?: LessonQaConfiguration;
}

export interface LearningValidationDependencies {
  store: CandidateStore;
  reconcile(candidate: LearningCandidate, options: ProviderOperationOptions): Promise<z.infer<typeof reconciliationSchema>>;
  authorize(candidate: LearningCandidate, options: ProviderOperationOptions): Promise<z.infer<typeof authorizationSchema>>;
  resolveChecker(candidate: LearningCandidate, checkerId: string, options: ProviderOperationOptions): Promise<LearningValidationChecker | undefined>;
  readCommitSnapshot(candidate: LearningCandidate, checkerId: string): LearningValidationCommitSnapshot;
}

export interface LearningValidationCommitSnapshot {
  authorization: z.infer<typeof authorizationSchema>;
  source: z.infer<typeof reconciliationSchema>;
  checker: LearningValidationChecker;
  qaAuditDigest?: string;
}

type ValidationCode = LessonQaBlockedCode | 'invalid_input' | 'candidate_unavailable' | 'scope_mismatch' | 'stale_candidate'
  | 'unsupported_kind' | 'evidence_unavailable' | 'insufficient_evidence' | 'source_unavailable'
  | 'unauthorized' | 'authorization_changed' | 'checker_unavailable' | 'checker_changed' | 'target_mismatch'
  | 'verification_failed' | 'invalid_receipt' | 'output_limit' | 'binding_mismatch' | 'insufficient_coverage'
  | 'assertion_failed' | 'cancelled' | 'timed_out' | 'storage_failed' | 'commit_guard_unavailable';

export type LearningValidationResult = { status: 'blocked'; code: ValidationCode } | {
  status: 'validated'; candidateId: string; candidateVersion: number; validatedVersion: number;
  executionId: string; receiptDigest: string;
};

class ValidationBlocked extends Error {
  constructor(readonly code: ValidationCode) { super(code); }
}
function fail(code: ValidationCode): never { throw new ValidationBlocked(code); }
function digest(input: unknown): string { return createHash('sha256').update(canonicalLearningJson(input)).digest('hex'); }
function same(first: unknown, second: unknown): boolean { return canonicalLearningJson(first) === canonicalLearningJson(second); }

export async function validateLearningCandidate(
  input: unknown,
  dependencies: LearningValidationDependencies,
  options: ProviderOperationOptions & { timeoutMs?: number } = {},
): Promise<LearningValidationResult> {
  const parsed = inputSchema.safeParse(input);
  const timeout = z.number().int().positive().max(DISTILLATION_LIMITS.timeoutMs).safeParse(options.timeoutMs ?? DISTILLATION_LIMITS.timeoutMs);
  if (!parsed.success || !timeout.success) return { status: 'blocked', code: 'invalid_input' };
  if (options.signal?.aborted) return { status: 'blocked', code: 'cancelled' };
  const request = parsed.data;
  const controller = new AbortController();
  const deadline = performance.now() + timeout.data;
  let timedOut = false;
  const cancel = () => controller.abort();
  const checkAbort = () => {
    if (performance.now() >= deadline) { timedOut = true; cancel(); }
    if (controller.signal.aborted) fail(timedOut ? 'timed_out' : 'cancelled');
  };
  const timer = setTimeout(() => { timedOut = true; cancel(); }, timeout.data);
  options.signal?.addEventListener('abort', cancel, { once: true });
  const operation = { signal: controller.signal };
  let rejectCancellation: () => void;
  const cancellation = new Promise<never>((_resolve, reject) => {
    rejectCancellation = () => reject(new ValidationBlocked(timedOut ? 'timed_out' : 'cancelled'));
    controller.signal.addEventListener('abort', rejectCancellation, { once: true });
  });

  const loadCandidate = () => {
    checkAbort();
    const candidate = dependencies.store.getCandidate(request.candidateId);
    if (!candidate) fail('candidate_unavailable');
    if (candidate.proposal.applicability.project !== request.scope) fail('scope_mismatch');
    if (candidate.version !== request.expectedVersion || candidate.state !== 'candidate') fail('stale_candidate');
    if (candidate.proposal.kind !== 'fact' && candidate.proposal.kind !== 'process' && candidate.proposal.kind !== 'lesson') fail('unsupported_kind');
    const proposal = candidateProposalSchema.safeParse(candidate.proposal);
    if (!proposal.success || candidate.digest !== digest(proposal.data)) fail('insufficient_evidence');
    return candidate;
  };

  const load = () => {
    const candidate = loadCandidate();
    const source = dependencies.store.getRequest(candidate.requestKey);
    if (!source || source.blockedReason || source.request.evidenceDigest !== candidate.evidenceDigest) fail('source_unavailable');
    if (source.request.scope !== request.scope) fail('scope_mismatch');
    const evidence = dependencies.store.getEvidencePack(candidate.evidenceDigest);
    if (!evidence) fail('evidence_unavailable');
    if (evidence.completeness !== 'complete') fail('insufficient_evidence');
    const refs = new Map(evidence.entries.map(entry => [entry.ref.id, entry.ref]));
    if (source.evidence.length !== refs.size || source.evidence.some(ref => !refs.has(ref.id) || !same(refs.get(ref.id), ref))) fail('insufficient_evidence');
    const ids = [...candidate.proposal.evidenceIds];
    if (candidate.proposal.kind === 'fact' && candidate.proposal.payload.classification !== 'fact') fail('insufficient_evidence');
    if (candidate.proposal.kind === 'process') {
      const steps = candidate.proposal.payload.steps;
      if (new Set(steps.map(step => step.id)).size !== steps.length || steps.some(step => step.missingEvidence || !step.evidenceIds.length)) fail('insufficient_evidence');
      ids.push(...steps.flatMap(step => step.evidenceIds));
    }
    if (ids.some(id => {
      const ref = refs.get(id);
      return !ref || ref.completeness !== 'complete' || ref.authority !== 'observed';
    })) fail('insufficient_evidence');
    return { candidate, source, evidence, refs };
  };

  const checkpoint = async () => {
    checkAbort();
    const candidate = loadCandidate();
    let authorization: z.infer<typeof authorizationSchema>;
    try { authorization = authorizationSchema.parse(await dependencies.authorize(structuredClone(candidate), operation)); }
    catch { checkAbort(); fail('unauthorized'); }
    checkAbort();
    if (!authorization.allowed) fail('unauthorized');
    try {
      const source = reconciliationSchema.parse(await dependencies.reconcile(structuredClone(candidate), operation));
      if (!source.current || source.evidenceDigest !== candidate.evidenceDigest) fail('source_unavailable');
    }
    catch { checkAbort(); fail('source_unavailable'); }
    const loaded = load();
    let selected: LearningValidationChecker;
    let checker: z.infer<typeof checkerSchema>;
    let doctor: NonNullable<VerificationProvider['doctor']>;
    try {
      const resolved = await dependencies.resolveChecker(structuredClone(loaded.candidate), request.checkerId, operation);
      checkAbort();
      if (!resolved) fail('checker_unavailable');
      selected = resolved;
      const { provider: _provider, ...configuration } = resolved;
      checker = checkerSchema.parse(configuration);
      if (checker.id !== request.checkerId || selected.provider.capabilities['test-execution'] !== true
        || typeof selected.provider.verify !== 'function') fail('checker_unavailable');
      if (typeof selected.provider.doctor !== 'function') fail('checker_unavailable');
      doctor = selected.provider.doctor;
      const diagnostics = await doctor.call(selected.provider, operation);
      checkAbort();
      if (!Array.isArray(diagnostics) || diagnostics.length > 32) fail('checker_unavailable');
      const supported = diagnostics.filter(entry => entry?.check === protocol);
      if (supported.length !== 1 || supported[0].ok !== true || selected.provider.doctor !== doctor
        || selected.provider.capabilities['test-execution'] !== true) fail('checker_unavailable');
    } catch { checkAbort(); fail('checker_unavailable'); }
    if (checker.target.scope !== request.scope
      || (loaded.candidate.proposal.targetRef && loaded.candidate.proposal.targetRef !== checker.target.ref)) fail('target_mismatch');
    let qa: Extract<LessonQaEvidenceResult, { status: 'verified' }> | undefined;
    if (loaded.candidate.proposal.kind === 'lesson') {
      const result = await verifyLessonQaEvidence({ candidateId: loaded.candidate.id, expectedVersion: loaded.candidate.version },
        { store: dependencies.store, qa: checker.qa }, operation);
      checkAbort();
      if (result.status !== 'verified') fail(result.code);
      qa = result;
    }
    const current = load();
    if (!same(loaded, current)) fail('stale_candidate');
    return { ...current, authorization, checker, qa, provider: selected.provider,
      verify: selected.provider.verify, doctor, providerId: selected.provider.id, capabilities: canonicalLearningJson(selected.provider.capabilities) };
  };

  const execute = async (): Promise<LearningValidationResult> => {
    const before = await checkpoint();
    checkAbort();
    const { candidate, evidence, refs } = before;
    const binding = { scope: request.scope, candidateId: candidate.id, candidateVersion: candidate.version,
      candidateDigest: candidate.digest, evidenceDigest: candidate.evidenceDigest, target: before.checker.target,
      checkerId: before.checker.id, checkerVersion: before.checker.version, configurationDigest: before.checker.configurationDigest,
      authorizationDigest: before.authorization.authorizationDigest, executionId: randomUUID(),
      ...(before.qa ? { qa: before.qa.binding, qaEvidence: before.qa.evidence } : {}) };
    const assertions: Array<{ node: string; expected: z.infer<typeof valueSchema>; evidence: z.infer<typeof referenceSchema>[] }> = [];
    const add = (node: string, expected: z.infer<typeof valueSchema>, ids = candidate.proposal.evidenceIds) => {
      assertions.push({ node, expected, evidence: ids.map(id => {
        const ref = refs.get(id)!;
        return { id: ref.id, digest: ref.digest, locator: ref.locator };
      }) });
    };
    if (candidate.proposal.kind === 'fact') {
      add('fact.subject', candidate.proposal.payload.subject);
      add('fact.rule', candidate.proposal.payload.rule);
      add('fact.authority', candidate.proposal.evidenceIds.map(id => refs.get(id)!.locator).sort());
    } else if (candidate.proposal.kind === 'process') {
      const payload = candidate.proposal.payload;
      add('process.entry', payload.entry);
      add('process.systems', payload.systems);
      add('process.preconditions', payload.preconditions);
      payload.steps.forEach((step, index) => {
        add(`process.steps.${index}.action`, step.action, step.evidenceIds);
        add(`process.steps.${index}.stateChange`, step.stateChange, step.evidenceIds);
      });
      add('process.exceptions', payload.exceptions);
      add('process.completion', payload.completion);
    } else if (candidate.proposal.kind === 'lesson') {
      const payload = candidate.proposal.payload;
      add('lesson.trigger', payload.trigger);
      add('lesson.rootCause', payload.rootCause);
      add('lesson.rootCauseStatus', payload.rootCauseStatus);
      add('lesson.attempts', payload.attempts);
      add('lesson.fix', payload.fix);
      add('lesson.prevention', payload.prevention);
      const applicability = candidate.proposal.applicability;
      add('lesson.project', applicability.project);
      add('lesson.environments', applicability.environments);
      add('lesson.versions', applicability.versions);
      add('lesson.applicabilityPreconditions', applicability.preconditions);
      add('lesson.exclusions', applicability.exclusions);
      add('lesson.invalidationConditions', applicability.invalidationConditions);
      const qa = before.qa!;
      const qaRefs = qa.evidence.map(ref => ({ id: ref.id, digest: ref.digest, locator: ref.locator }));
      assertions.filter(assertion => assertion.node === 'lesson.fix' || assertion.node === 'lesson.prevention')
        .forEach(assertion => { assertion.evidence.push(...qaRefs); });
      assertions.push({ node: 'lesson.fixTargetRevision', expected: qa.binding.targetRevision, evidence: qaRefs });
    }
    let verification: VerificationResult | undefined;
    try {
      verification = await before.verify.call(before.provider, { target: canonicalLearningJson({ protocol, binding,
        candidate, evidence, assertions }), timeoutMs: timeout.data }, operation);
    } catch { checkAbort(); }
    checkAbort();
    const after = await checkpoint();
    checkAbort();
    if (!same(before.candidate, after.candidate) || !same(before.source, after.source)
      || !same(before.evidence, after.evidence)) fail('stale_candidate');
    if (!same(before.authorization, after.authorization)) fail('authorization_changed');
    if (!same(before.qa ?? null, after.qa ?? null)) fail('audit_changed');
    if (!same(before.checker.target, after.checker.target)) fail('target_mismatch');
    if (!same(before.checker, after.checker) || before.provider !== after.provider || before.verify !== after.verify || before.doctor !== after.doctor
      || before.providerId !== after.providerId || before.capabilities !== after.capabilities) fail('checker_changed');
    if (!verification || verification.passed !== true) fail('verification_failed');
    if (typeof verification.output !== 'string') fail('invalid_receipt');
    if (Buffer.byteLength(verification.output, 'utf8') > DISTILLATION_LIMITS.outputBytes) fail('output_limit');
    let decoded: unknown;
    try { decoded = JSON.parse(verification.output); } catch { fail('invalid_receipt'); }
    const parsedReport = reportSchema.safeParse(decoded);
    if (!parsedReport.success) fail('invalid_receipt');
    const report = parsedReport.data;
    if (report.binding === undefined || !same(report.binding, binding)) fail('binding_mismatch');
    const returned = new Map(report.assertions.map(assertion => [assertion.node, assertion]));
    if (returned.size !== assertions.length || returned.size !== report.assertions.length) fail('insufficient_coverage');
    for (const required of assertions) {
      const actual = returned.get(required.node);
      if (!actual) fail('insufficient_coverage');
      if (actual.status !== 'observed') fail('insufficient_evidence');
      if (!same(actual.evidence, required.evidence)) fail('insufficient_evidence');
      if (!same(actual.expected, required.expected) || !same(actual.actual, required.expected)) fail('assertion_failed');
    }
    const receiptDigest = digest(report);
    const audit = canonicalLearningJson({ report, receiptDigest });
    const results = Buffer.from(audit, 'utf8').toString('base64').match(/.{1,1800}/g)!
      .map(chunk => `json-base64-v1:${chunk}`);
    checkAbort();
    const beforeCommit = () => {
      checkAbort();
      let commit: LearningValidationCommitSnapshot;
      let checker: z.infer<typeof checkerSchema>;
      try {
        const snapshot = dependencies.readCommitSnapshot(structuredClone(candidate), request.checkerId);
        const { provider, ...configuration } = snapshot.checker;
        checker = checkerSchema.parse(configuration);
        commit = { authorization: authorizationSchema.parse(snapshot.authorization),
          source: reconciliationSchema.parse(snapshot.source), checker: { ...checker, provider }, qaAuditDigest: snapshot.qaAuditDigest };
      } catch { checkAbort(); fail('commit_guard_unavailable'); }
      checkAbort();
      if (!commit.authorization.allowed) fail('unauthorized');
      if (!same(commit.authorization, before.authorization)) fail('authorization_changed');
      if (!commit.source.current || commit.source.evidenceDigest !== candidate.evidenceDigest) fail('source_unavailable');
      if (!same(checker.target, before.checker.target)) fail('target_mismatch');
      if (!same(checker, before.checker) || commit.checker.provider !== before.provider
        || commit.checker.provider.id !== before.providerId || commit.checker.provider.verify !== before.verify
        || commit.checker.provider.doctor !== before.doctor || canonicalLearningJson(commit.checker.provider.capabilities) !== before.capabilities) fail('checker_changed');
      if (before.qa && commit.qaAuditDigest !== before.qa.binding.auditDigest) fail('audit_changed');
      const current = load();
      if (!same(current.candidate, candidate) || !same(current.source, before.source) || !same(current.evidence, evidence)) fail('stale_candidate');
      if (before.qa) {
        const qaRunId = before.qa.binding.qaRunId;
        if (current.source.request.sourceRunId === qaRunId || dependencies.store.listAnalysisAttempts(candidate.requestKey)
          .some(attempt => attempt.analysisRunId === qaRunId || attempt.sessionId === qaRunId)) fail('qa_not_independent');
      }
      checkAbort();
    };
    let validated: LearningCandidate;
    try {
      validated = dependencies.store.recordValidation(candidate.id, candidate.version, {
        candidateDigest: candidate.digest, evidenceDigest: evidence.digest,
        validatorVersion: `${protocol}:${binding.executionId}`, passed: true, results }, beforeCommit);
    } catch (error) {
      if (error instanceof ValidationBlocked) throw error;
      checkAbort();
      const current = dependencies.store.getCandidate(candidate.id);
      if (!current || !same(current, candidate)) fail('stale_candidate');
      fail('storage_failed');
    }
    return { status: 'validated', candidateId: candidate.id, candidateVersion: candidate.version,
      validatedVersion: validated.version, executionId: binding.executionId, receiptDigest };
  };

  try {
    if (options.signal?.aborted) cancel();
    return await Promise.race([execute(), cancellation]);
  } catch (error) {
    return { status: 'blocked', code: error instanceof ValidationBlocked ? error.code : 'storage_failed' };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', cancel);
    controller.signal.removeEventListener('abort', rejectCancellation!);
  }
}
