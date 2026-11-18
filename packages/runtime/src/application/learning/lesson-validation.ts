import { createHash } from 'node:crypto';
import type { RunEvent } from '@afk/core';
import { z } from 'zod';
import type { CandidateStore } from './candidate-store.js';
import { candidateProposalSchema, distillationRequestSchema, DISTILLATION_LIMITS, type EvidenceRef } from './contracts.js';
import type { ProviderOperationOptions } from '../../plugin-sdk/capabilities.js';
import { JsonlEventStore, verifyRunEventHistory } from '../../infrastructure/observability/jsonl-event-store.js';
import { parseWorkItemId } from '../../domain/work-item/identity.js';
import { buildEvidencePack, matchesEvidenceWorkItem, readEvidenceSource, validateEvidencePack } from './evidence.js';
import { canonicalLearningJson, learningDigestSchema } from './requests.js';
import { repairedRunEvidenceFromEvents, successfulRunEvidenceFromEvents } from './run-evidence.js';
import { lessonQaConfigurationSchema, lessonRepairBindingSchema } from './validation-input.js';

const identity = z.string().min(1).max(512).refine(value => value.trim() === value && !/[\0\r\n\t]/.test(value));
const revision = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const inputSchema = z.object({ candidateId: learningDigestSchema, expectedVersion: z.number().int().positive().safe() }).strict();
const configurationSchema = lessonQaConfigurationSchema.refine(value => {
  try {
    const parsed = parseWorkItemId(value.workItemId);
    return parsed.id === value.workItemId && `${parsed.platform}:${parsed.projectKey}` === value.scope;
  } catch { return false; }
});
const eventSchema = z.object({ id: identity, schemaVersion: z.literal(1), sequence: z.number().int().positive().safe(),
  type: identity, occurredAt: z.string().datetime({ offset: true }), observedAt: z.string().datetime({ offset: true }),
  correlationId: identity, integrity: z.object({ hash: learningDigestSchema, prevHash: learningDigestSchema.optional() }).strict(),
  context: z.object({ runId: identity, workItemId: identity, traceId: identity, profileId: identity,
    attempt: z.number().int().positive().safe(), purpose: z.enum(['execution', 'learning']).optional(),
    actor: z.object({ kind: z.enum(['system', 'cli', 'agent', 'loop', 'policy', 'human']), id: identity }).strict(),
  }).passthrough(), data: z.object({ kind: identity }).passthrough(),
}).passthrough().refine(value => value.type === value.data.kind);
const authoritySchemas = {
  'qa.started': z.object({ kind: z.literal('qa.started') }).passthrough(),
  'qa.passed': z.object({ kind: z.literal('qa.passed') }).passthrough(),
  'qa.failed': z.object({ kind: z.literal('qa.failed') }).passthrough(),
  'commit.recorded': z.object({ kind: z.literal('commit.recorded'), phase: z.enum(['implementation', 'qa']), commitSha: revision, branch: identity }).passthrough(),
  'decision.made': z.object({ kind: z.literal('decision.made'), command: identity, accepted: z.boolean(), reason: z.string().max(16384).optional() }).passthrough(),
  'run.finished': z.object({ kind: z.literal('run.finished'), outcome: z.enum(['succeeded', 'failed', 'cancelled']) }).passthrough(),
  'change.published': z.object({ kind: z.literal('change.published'), changeId: identity, url: z.string().max(4096) }).passthrough(),
  'human_gate.opened': z.object({ kind: z.literal('human_gate.opened'), gateId: identity, reason: z.string().max(4096) }).passthrough(),
  'change.merge_verified': z.object({ kind: z.literal('change.merge_verified'), changeId: identity }).passthrough(),
};

class LessonQaBlocked extends Error {
  constructor(readonly code: LessonQaBlockedCode) { super(code); }
}
function fail(code: LessonQaBlockedCode): never { throw new LessonQaBlocked(code); }
const digest = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');

export type LessonQaConfiguration = z.infer<typeof lessonQaConfigurationSchema>;

export interface LessonQaDependencies {
  store: Pick<CandidateStore, 'getCandidate' | 'getRequest' | 'getEvidencePack' | 'listAnalysisAttempts'>;
  qa?: LessonQaConfiguration;
}

export type LessonQaBlockedCode = 'invalid_input' | 'qa_unconfigured' | 'candidate_unavailable' | 'stale_candidate'
  | 'insufficient_evidence' | 'source_unavailable' | 'scope_mismatch' | 'qa_not_independent' | 'audit_unavailable'
  | 'audit_changed' | 'qa_unverified' | 'target_mismatch' | 'output_limit' | 'cancelled';

export type LessonQaEvidenceResult = { status: 'blocked'; code: LessonQaBlockedCode } | {
  status: 'verified';
  binding: {
    candidateId: string;
    candidateVersion: number;
    candidateDigest: string;
    evidenceDigest: string;
    scope: string;
    workItemId: string;
    qaRunId: string;
    targetRevision: string;
    auditDigest: string;
    auditHead: string;
    auditSequence: number;
  };
  evidence: EvidenceRef[];
  repair?: { binding: z.infer<typeof lessonRepairBindingSchema>; evidence: EvidenceRef[] };
};

export async function verifyLessonQaEvidence(
  input: unknown,
  dependencies: LessonQaDependencies,
  options: ProviderOperationOptions = {},
): Promise<LessonQaEvidenceResult> {
  if (options.signal?.aborted) return { status: 'blocked', code: 'cancelled' };
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) return { status: 'blocked', code: 'invalid_input' };
  if (dependencies.qa === undefined) return { status: 'blocked', code: 'qa_unconfigured' };
  const configuration = configurationSchema.safeParse(dependencies.qa);
  if (!configuration.success || canonicalLearningJson(configuration.data) !== canonicalLearningJson(dependencies.qa)) return { status: 'blocked', code: 'invalid_input' };
  const qa = configuration.data;
  const checkAbort = () => { if (options.signal?.aborted) fail('cancelled'); };
  const load = () => {
    checkAbort();
    const candidate = dependencies.store.getCandidate(parsed.data.candidateId);
    if (!candidate) fail('candidate_unavailable');
    if (candidate.id !== parsed.data.candidateId || candidate.state !== 'candidate' || candidate.version !== parsed.data.expectedVersion) fail('stale_candidate');
    const proposal = candidateProposalSchema.safeParse(candidate.proposal);
    if (!proposal.success || proposal.data.kind !== 'lesson' || proposal.data.payload.rootCauseStatus !== 'confirmed'
      || digest(canonicalLearningJson(proposal.data)) !== candidate.digest) fail('insufficient_evidence');
    const source = dependencies.store.getRequest(candidate.requestKey);
    const request = distillationRequestSchema.safeParse(source?.request);
    if (!source || source.blockedReason || !request.success || !request.data.sourceRunId
      || request.data.evidenceDigest !== candidate.evidenceDigest) fail('source_unavailable');
    if (proposal.data.applicability.project !== qa.scope || request.data.scope !== qa.scope || request.data.workItemId !== qa.workItemId) fail('scope_mismatch');
    const attempts = dependencies.store.listAnalysisAttempts(candidate.requestKey);
    const roles = [qa.runId, ...(qa.repair ? [qa.repair.failure.runId, qa.repair.fix.runId] : [])];
    if (request.data.sourceRunId === qa.runId || (qa.repair && (qa.repair.failure.runId !== request.data.sourceRunId
      || new Set(roles).size !== roles.length))
      || attempts.some(attempt => (attempt.analysisRunId !== undefined && roles.includes(attempt.analysisRunId)) || (attempt.sessionId && roles.includes(attempt.sessionId)))) fail('qa_not_independent');
    const stored = dependencies.store.getEvidencePack(candidate.evidenceDigest);
    if (!stored) fail('insufficient_evidence');
    const evidence = validateEvidencePack(stored);
    if (evidence.digest !== candidate.evidenceDigest || evidence.completeness !== 'complete') fail('insufficient_evidence');
    const refs = new Map(evidence.entries.map(entry => [entry.ref.id, entry.ref]));
    if (source.evidence.length !== refs.size || source.evidence.some(ref => canonicalLearningJson(refs.get(ref.id) ?? null) !== canonicalLearningJson(ref))
      || proposal.data.evidenceIds.some(id => refs.get(id)?.authority !== 'observed' || refs.get(id)?.completeness !== 'complete')) fail('insufficient_evidence');
    for (const entry of evidence.entries.filter(entry => entry.ref.authority === 'observed')) {
      let decoded: unknown;
      try { decoded = JSON.parse(entry.content); } catch { fail('insufficient_evidence'); }
      const event = eventSchema.safeParse(decoded);
      if (!event.success || event.data.context.purpose === 'learning') fail('insufficient_evidence');
      if (event.data.context.runId === qa.runId) fail('qa_not_independent');
      if (event.data.context.runId !== request.data.sourceRunId || !matchesEvidenceWorkItem(entry, event.data.context.workItemId, qa.workItemId)) fail('scope_mismatch');
    }
    return { candidate, source, evidence, attempts };
  };
  try {
    const loaded = load();
    const repairReads: Array<() => Promise<Buffer>> = [];
    let repair: Extract<LessonQaEvidenceResult, { status: 'verified' }>['repair'];
    if (qa.repair) {
      const readRepair = async (pin: NonNullable<LessonQaConfiguration['repair']>['failure']) => {
        const auditPath = new JsonlEventStore({ root: pin.root }).pathFor(pin.runId);
        const read = async () => {
          checkAbort();
          const bytes = await readEvidenceSource(auditPath, pin.root, DISTILLATION_LIMITS.evidenceBytes);
          checkAbort();
          if (!bytes) fail('audit_unavailable');
          if (digest(bytes) !== pin.auditDigest) fail('audit_changed');
          return bytes;
        };
        const bytes = await read();
        repairReads.push(read);
        const history: RunEvent[] = new TextDecoder('utf-8', { fatal: true }).decode(bytes).split('\n').filter(line => line.trim()).map(line => JSON.parse(line));
        if (!history.length || history.length > 4096 || history.some(event => !eventSchema.safeParse(event).success)) fail('qa_unverified');
        const integrity = verifyRunEventHistory(pin.runId, history);
        if (!integrity.valid || !integrity.lastHash) fail('qa_unverified');
        return { history, integrity, auditPath };
      };
      const failure = await readRepair(qa.repair.failure);
      const fix = await readRepair(qa.repair.fix);
      const failureSources = loaded.evidence.sources.filter(source => source.kind === 'audit');
      if (failureSources.length !== 1 || failureSources[0].sourceDigest !== qa.repair.failure.auditDigest
        || failureSources[0].messageCount !== failure.history.length) fail('source_unavailable');
      let proof: ReturnType<typeof repairedRunEvidenceFromEvents>;
      try { proof = repairedRunEvidenceFromEvents({ scope: qa.scope, workItemId: qa.workItemId,
        failureRunId: qa.repair.failure.runId, fixRunId: qa.repair.fix.runId, qaRunId: qa.runId, targetRevision: qa.targetRevision },
      failure.history, fix.history); } catch { fail('qa_unverified'); }
      const failureRef = loaded.evidence.entries.find(entry => entry.position.sourceId === failureSources[0].id
        && failure.history[entry.position.auditSequence! - 1]?.id === proof.failureEventId)?.ref;
      const fixPack = await buildEvidencePack({ sources: [{ id: 'lesson-fix', kind: 'audit', path: fix.auditPath,
        allowedRoot: qa.repair.fix.root, runId: qa.repair.fix.runId, expectedDigest: qa.repair.fix.auditDigest }] });
      if (!failureRef || fixPack.completeness !== 'complete' || fixPack.entries.length !== fix.history.length) fail('qa_unverified');
      const fixRefs = [proof.fixCommitEventId, proof.fixCompletionEventId].map(id => fixPack.entries.find(entry =>
        fix.history[entry.position.auditSequence! - 1]?.id === id)?.ref);
      if (fixRefs.some(ref => !ref)) fail('qa_unverified');
      const bind = (pin: NonNullable<LessonQaConfiguration['repair']>['failure'], audit: typeof failure) => ({
        runId: pin.runId, auditDigest: pin.auditDigest, auditHead: audit.integrity.lastHash!, auditSequence: audit.integrity.lastSequence,
      });
      repair = { binding: { failure: bind(qa.repair.failure, failure), fix: bind(qa.repair.fix, fix), ...proof },
        evidence: [failureRef, ...fixRefs as EvidenceRef[]] };
    }
    const path = new JsonlEventStore({ root: qa.root }).pathFor(qa.runId);
    const readAudit = async () => {
      checkAbort();
      const bytes = await readEvidenceSource(path, qa.root, 1024 * 1024);
      checkAbort();
      if (!bytes) fail('audit_unavailable');
      if (digest(bytes) !== qa.auditDigest) fail('audit_changed');
      return bytes;
    };
    const bytes = await readAudit();
    if (bytes.length > DISTILLATION_LIMITS.evidenceBytes) fail('output_limit');
    const history: RunEvent[] = new TextDecoder('utf-8', { fatal: true }).decode(bytes).split('\n').filter(line => line.trim()).map(line => JSON.parse(line));
    if (!history.length || history.length > 4096) fail('qa_unverified');
    const integrity = verifyRunEventHistory(qa.runId, history);
    if (!integrity.valid || !integrity.lastHash) fail('qa_unverified');
    for (const event of history) {
      checkAbort();
      if (!eventSchema.safeParse(event).success) fail('qa_unverified');
      const authority = authoritySchemas[event.data.kind as keyof typeof authoritySchemas];
      if (authority && !authority.safeParse(event.data).success) fail('qa_unverified');
      const controlsQa = event.data.kind === 'decision.made' ? event.data.command === 'experience.qa-target'
        : event.data.kind === 'commit.recorded' ? event.data.phase === 'qa' : Boolean(authority);
      if (controlsQa && event.context.actor.kind !== 'system') fail('qa_unverified');
    }
    let audit: ReturnType<typeof successfulRunEvidenceFromEvents>;
    try { audit = successfulRunEvidenceFromEvents({ scope: qa.scope, runId: qa.runId, workItemId: qa.workItemId, evidence: [] }, history); }
    catch { fail('qa_unverified'); }
    if (audit.qaCommit !== qa.targetRevision || audit.qaTarget?.target?.revision !== qa.targetRevision
      || audit.qaTarget.target.project !== qa.scope || audit.qaTarget.target.dirty !== false) fail('target_mismatch');
    const last = (predicate: (event: RunEvent) => boolean) => history.map((event, index) => predicate(event) ? index : -1).filter(index => index >= 0).at(-1) ?? -1;
    const started = last(event => event.data.kind === 'qa.started');
    const passed = last(event => event.data.kind === 'qa.passed');
    const target = last(event => event.data.kind === 'decision.made' && event.data.command === 'experience.qa-target');
    const commit = last(event => event.data.kind === 'commit.recorded' && event.data.phase === 'qa');
    const completion = history.findIndex((event, index) => index > started && (event.data.kind === 'run.finished' ? event.data.outcome === 'succeeded'
      : event.data.kind === 'human_gate.opened' ? event.data.gateId === `merge:${audit.publishedChange}`
      : event.data.kind === 'change.merge_verified' && event.data.changeId === audit.publishedChange));
    if (!(started < target && target < passed && started < commit && commit < completion && passed < completion)) fail('qa_unverified');
    const pack = await buildEvidencePack({ sources: [{ id: 'lesson-qa', kind: 'audit', path, allowedRoot: qa.root,
      runId: qa.runId, expectedDigest: qa.auditDigest }] });
    checkAbort();
    if (pack.completeness !== 'complete' || pack.entries.length !== history.length) fail('qa_unverified');
    await readAudit();
    for (const read of repairReads) await read();
    if (canonicalLearningJson(loaded) !== canonicalLearningJson(load())) fail('stale_candidate');
    if (canonicalLearningJson(dependencies.qa) !== canonicalLearningJson(qa)) fail('audit_changed');
    const sequences = new Set([started, target, commit, passed, completion].map(index => index + 1));
    const evidence = pack.entries.filter(entry => sequences.has(entry.position.auditSequence ?? 0)).map(entry => entry.ref);
    if (evidence.length !== sequences.size) fail('qa_unverified');
    const result: LessonQaEvidenceResult = { status: 'verified', binding: {
      candidateId: loaded.candidate.id, candidateVersion: loaded.candidate.version, candidateDigest: loaded.candidate.digest,
      evidenceDigest: loaded.candidate.evidenceDigest, scope: qa.scope, workItemId: qa.workItemId, qaRunId: qa.runId,
      targetRevision: qa.targetRevision, auditDigest: qa.auditDigest, auditHead: integrity.lastHash, auditSequence: integrity.lastSequence,
    }, evidence, ...(repair ? { repair } : {}) };
    if (Buffer.byteLength(JSON.stringify(result)) > 16 * 1024) fail('output_limit');
    checkAbort();
    return result;
  } catch (error) {
    if (options.signal?.aborted) return { status: 'blocked', code: 'cancelled' };
    return { status: 'blocked', code: error instanceof LessonQaBlocked ? error.code : 'audit_unavailable' };
  }
}
