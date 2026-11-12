import { createHash } from 'node:crypto';
import { z } from 'zod';
import { canonicalProjectKey, parseCanonicalProject, parseWorkItemId } from '../../domain/work-item/identity.js';

export const DISTILLATION_LIMITS = {
  evidenceBytes: 128 * 1024, outputBytes: 32 * 1024, candidates: 10,
  pendingRequests: 1000, pendingBytes: 16 * 1024 * 1024,
  records: 2000, recordBytes: 32 * 1024 * 1024,
  timeoutMs: 120_000, attempts: 2, dailyCalls: 20,
} as const;

function text(bytes: number) {
  return z.string().max(bytes).trim().min(1)
    .refine(value => Buffer.byteLength(value, 'utf8') <= bytes, 'UTF-8 text exceeds limit')
    .refine(value => !value.includes('\0'), 'NUL is not allowed');
}

const identity = text(512).refine(value => !/[\r\n\t]/.test(value), 'Identity must be one line');
export const learningScopeSchema = identity.superRefine((value, context) => {
  try {
    const parsed = parseCanonicalProject(value);
    if (`${parsed.platform}:${canonicalProjectKey(parsed.platform, parsed.projectId, parsed.host)}` !== value) throw new Error();
  } catch {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Expected canonical project scope' });
  }
});
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const strings = z.array(text(1024)).max(32);
const evidenceIds = z.array(identity).max(64).refine(values => new Set(values).size === values.length, 'Duplicate evidence IDs');
const targetRef = text(512).refine(value => /^[a-z][a-z0-9-]*:[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value), 'Expected logical target reference')
  .refine(value => !value.split(/[/:]/).some(part => part === '.' || part === '..'), 'Invalid logical target reference');

export const evidenceRefSchema = z.object({
  id: identity,
  kind: z.enum(['audit', 'message', 'tool-result', 'code', 'test', 'human-confirmation']),
  digest, locator: identity, completeness: z.enum(['complete', 'partial']),
  authority: z.enum(['observed', 'declared', 'inferred']),
}).strict();

export const distillationRequestSchema = z.object({
  version: z.literal(1), scope: learningScopeSchema, sourceId: identity,
  sourceRunId: identity.optional(), workItemId: identity.optional(), evidenceDigest: digest,
  analyzerVersion: identity, reason: z.enum(['completed', 'repaired', 'correction', 'import']),
}).strict().superRefine((value, context) => {
  if (value.workItemId === undefined) return;
  try {
    const parsed = parseWorkItemId(value.workItemId);
    if (parsed.id !== value.workItemId || `${parsed.platform}:${parsed.projectKey}` !== value.scope) throw new Error();
  } catch {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['workItemId'], message: 'Work item must belong to the canonical project scope' });
  }
});

export const candidateStateSchema = z.enum(['candidate', 'conflict', 'validated', 'published', 'rejected', 'superseded', 'revoked']);
const applicability = z.object({
  project: learningScopeSchema, environments: strings, versions: strings,
  preconditions: strings, exclusions: strings, invalidationConditions: strings,
}).strict();
const proposal = z.object({
  title: text(256), statement: text(4096), evidenceIds: evidenceIds.refine(values => values.length > 0, 'Evidence is required'),
  applicability, targetRef: targetRef.optional(),
}).strict();
const processStep = z.object({
  id: identity, action: text(2048), stateChange: text(1024), evidenceIds,
  missingEvidence: text(1024).optional(),
}).strict().refine(value => value.evidenceIds.length > 0 || value.missingEvidence !== undefined,
  'Process node requires evidence or an explicit gap');
const evaluationCase = z.object({
  kind: z.enum(['normal', 'recovery', 'refusal']), input: text(2048), expected: text(2048),
}).strict();
const skillPayload = z.object({
  targetSkill: targetRef.optional(), originalDigest: digest.optional(), newReason: text(1024).optional(),
  triggers: strings.min(1), prohibitedConditions: strings, inputs: z.array(z.object({
    name: identity, description: text(1024), required: z.boolean(),
  }).strict()).max(32), branches: strings, recovery: strings, completion: text(2048),
  patch: text(24 * 1024), evaluationCases: z.array(evaluationCase).min(3).max(12),
}).strict().refine(value => value.targetSkill ? value.originalDigest !== undefined : value.newReason !== undefined,
  'Existing skill requires original digest; new skill requires justification')
  .refine(value => ['normal', 'recovery', 'refusal'].every(kind => value.evaluationCases.some(entry => entry.kind === kind)),
    'Skill evaluation requires normal, recovery and refusal cases');

export const candidateProposalSchema = z.discriminatedUnion('kind', [
  proposal.extend({ kind: z.literal('fact'), payload: z.object({
    subject: text(512), rule: text(4096), classification: z.enum(['fact', 'proposal']),
  }).strict() }),
  proposal.extend({ kind: z.literal('process'), payload: z.object({
    entry: text(1024), systems: strings.min(1), preconditions: strings,
    steps: z.array(processStep).min(1).max(32), exceptions: strings, completion: text(2048),
  }).strict() }),
  proposal.extend({ kind: z.literal('lesson'), payload: z.object({
    trigger: text(1024), rootCause: text(2048), rootCauseStatus: z.enum(['hypothesis', 'confirmed']),
    attempts: strings, fix: text(4096), prevention: strings.min(1),
  }).strict() }),
  proposal.extend({ kind: z.literal('skill'), payload: skillPayload }),
  proposal.extend({ kind: z.literal('tool'), payload: z.object({
    existingTools: strings, inputSchema: z.record(z.unknown()), outputSchema: z.record(z.unknown()),
    dependencies: strings, permissions: strings, timeoutMs: z.number().int().positive().max(120_000),
    sideEffects: z.enum(['none', 'filesystem', 'network', 'process', 'mixed']),
    idempotency: text(2048), recovery: text(2048), source: text(24 * 1024),
    tests: z.array(evaluationCase).min(3).max(12),
  }).strict() }),
]);

export const distillationOutputSchema = z.object({
  version: z.literal(1), candidates: z.array(candidateProposalSchema).max(DISTILLATION_LIMITS.candidates),
  warnings: z.array(text(2048)).max(32),
}).strict();

export type EvidenceRef = z.infer<typeof evidenceRefSchema>;
export type DistillationRequest = z.infer<typeof distillationRequestSchema>;
export type CandidateProposal = z.infer<typeof candidateProposalSchema>;
export type DistillationOutput = z.infer<typeof distillationOutputSchema>;
export type AssetKind = CandidateProposal['kind'];
export type CandidateState = z.infer<typeof candidateStateSchema>;

export function distillationKey(input: DistillationRequest): string {
  const request = distillationRequestSchema.parse(input);
  return createHash('sha256').update(JSON.stringify([
    request.scope, request.sourceId, request.evidenceDigest, request.analyzerVersion,
  ])).digest('hex');
}

export function parseDistillationOutput(input: unknown, source: DistillationRequest, evidence: readonly EvidenceRef[]): DistillationOutput {
  const request = distillationRequestSchema.parse(source);
  const serialized = typeof input === 'string' ? input : JSON.stringify(input);
  if (serialized === undefined || Buffer.byteLength(serialized) > DISTILLATION_LIMITS.outputBytes) throw new Error('Distillation output exceeds size limit');
  const output = distillationOutputSchema.parse(JSON.parse(serialized));
  const available = new Set(evidence.map(entry => evidenceRefSchema.parse(entry).id));
  if (available.size !== evidence.length) throw new Error('Duplicate evidence IDs');
  for (const candidate of output.candidates) {
    if (candidate.applicability.project !== request.scope) throw new Error('Candidate project differs from request scope');
    const refs = [...candidate.evidenceIds, ...(candidate.kind === 'process' ? candidate.payload.steps.flatMap(step => step.evidenceIds) : [])];
    if (refs.some(ref => !available.has(ref))) throw new Error('Unknown evidence reference');
  }
  return output;
}

const transitions: Record<CandidateState, readonly CandidateState[]> = {
  candidate: ['conflict', 'validated', 'rejected'], conflict: ['candidate', 'rejected', 'revoked'],
  validated: ['published', 'conflict', 'superseded', 'revoked'],
  published: ['conflict', 'superseded', 'revoked'], rejected: [], superseded: [], revoked: [],
};

export function assertCandidateTransition(current: CandidateState, next: CandidateState): void {
  candidateStateSchema.parse(current);
  candidateStateSchema.parse(next);
  if (current !== next && !transitions[current].includes(next)) throw new Error(`Invalid learning candidate transition: ${current} → ${next}`);
}
