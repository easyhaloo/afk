import { createHash } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';
import type { RunEvent } from '@afk/core';
import { z } from 'zod';
import type { CandidateStore } from './candidate-store.js';
import { candidateProposalSchema, distillationRequestSchema, DISTILLATION_LIMITS, learningScopeSchema, type EvidenceRef } from './contracts.js';
import type { ProviderOperationOptions } from '../../plugin-sdk/capabilities.js';
import { JsonlEventStore, verifyRunEventHistory } from '../../infrastructure/observability/jsonl-event-store.js';
import { parseWorkItemId } from '../../domain/work-item/identity.js';
import { buildEvidencePack, readEvidenceSource, validateEvidencePack } from './evidence.js';
import { canonicalLearningJson, learningDigestSchema } from './requests.js';
import { successfulRunEvidenceFromEvents } from './runtime.js';

const identity = z.string().min(1).max(512).refine(value => value.trim() === value && !/[\0\r\n\t]/.test(value));
const revision = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const inputSchema = z.object({ candidateId: learningDigestSchema, expectedVersion: z.number().int().positive().safe() }).strict();
const configurationSchema = z.object({ scope: learningScopeSchema, workItemId: identity, runId: identity,
  targetRevision: revision, auditDigest: learningDigestSchema,
  root: z.string().min(1).max(4096).refine(value => isAbsolute(value) && resolve(value) === value && !/[\0\r\n]/.test(value)),
}).strict().refine(value => {
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

export interface LessonQaConfiguration {
  scope: string;
  workItemId: string;
  runId: string;
  targetRevision: string;
  root: string;
  auditDigest: string;
}

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
    if (request.data.sourceRunId === qa.runId || attempts.some(attempt => attempt.analysisRunId === qa.runId || attempt.sessionId === qa.runId)) fail('qa_not_independent');
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
      if (event.data.context.runId !== request.data.sourceRunId || event.data.context.workItemId !== qa.workItemId) fail('scope_mismatch');
    }
    return { candidate, source, evidence, attempts };
  };
  try {
    const loaded = load();
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
    if (canonicalLearningJson(loaded) !== canonicalLearningJson(load())) fail('stale_candidate');
    if (canonicalLearningJson(dependencies.qa) !== canonicalLearningJson(qa)) fail('audit_changed');
    const sequences = new Set([started, target, commit, passed, completion].map(index => index + 1));
    const evidence = pack.entries.filter(entry => sequences.has(entry.position.auditSequence ?? 0)).map(entry => entry.ref);
    if (evidence.length !== sequences.size) fail('qa_unverified');
    const result: LessonQaEvidenceResult = { status: 'verified', binding: {
      candidateId: loaded.candidate.id, candidateVersion: loaded.candidate.version, candidateDigest: loaded.candidate.digest,
      evidenceDigest: loaded.candidate.evidenceDigest, scope: qa.scope, workItemId: qa.workItemId, qaRunId: qa.runId,
      targetRevision: qa.targetRevision, auditDigest: qa.auditDigest, auditHead: integrity.lastHash, auditSequence: integrity.lastSequence,
    }, evidence };
    if (Buffer.byteLength(JSON.stringify(result)) > 16 * 1024) fail('output_limit');
    checkAbort();
    return result;
  } catch (error) {
    if (options.signal?.aborted) return { status: 'blocked', code: 'cancelled' };
    return { status: 'blocked', code: error instanceof LessonQaBlocked ? error.code : 'audit_unavailable' };
  }
}
