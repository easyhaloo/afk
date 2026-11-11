import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { RunEvent } from '@afk/core';
import { z } from 'zod';
import { JsonlEventStore, verifyRunEventHistory } from '../../infrastructure/observability/jsonl-event-store.js';
import type { ProviderOperationOptions } from '../../plugin-sdk/capabilities.js';
import type { CandidateStore, LearningCandidate } from './candidate-store.js';
import { candidateProposalSchema, distillationRequestSchema, DISTILLATION_LIMITS, evidenceRefSchema, type EvidenceRef } from './contracts.js';
import { redactEvidenceText, validateEvidencePack } from './evidence.js';
import { assertKnowledgeDirectory, KNOWLEDGE_FILE_BYTES, knowledgeFile, readKnowledgeAuthorization, readKnowledgeGrant } from './knowledge.js';
import { canonicalLearningJson, learningDigestSchema, learningIdentitySchema } from './requests.js';
import { lessonQaConfigurationSchema } from './validation.js';

const protocol = 'learning-validation-v1';
const digest = (value: unknown) => bytesDigest(canonicalLearningJson(value));
const bytesDigest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const same = (first: unknown, second: unknown) => canonicalLearningJson(first) === canonicalLearningJson(second);
const integer = z.number().int().positive().safe();
const qaBindingSchema = z.object({ candidateId: learningDigestSchema, candidateVersion: integer, candidateDigest: learningDigestSchema,
  evidenceDigest: learningDigestSchema, scope: learningIdentitySchema, workItemId: learningIdentitySchema, qaRunId: learningIdentitySchema,
  targetRevision: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/), auditDigest: learningDigestSchema,
  auditHead: learningDigestSchema, auditSequence: integer }).strict();
const bindingSchema = z.object({ scope: learningIdentitySchema, candidateId: learningDigestSchema, candidateVersion: integer,
  candidateDigest: learningDigestSchema, evidenceDigest: learningDigestSchema,
  target: z.object({ scope: learningIdentitySchema, ref: learningIdentitySchema, revision: learningIdentitySchema,
    snapshotDigest: learningDigestSchema }).strict(), checkerId: learningIdentitySchema, checkerVersion: learningIdentitySchema,
  configurationDigest: learningDigestSchema, authorizationDigest: learningDigestSchema, executionId: z.string().uuid(),
  qa: qaBindingSchema, qaEvidence: z.array(evidenceRefSchema).length(5) }).strict();
const referenceSchema = z.object({ id: learningIdentitySchema, digest: learningDigestSchema, locator: learningIdentitySchema }).strict();
const valueSchema = z.union([z.string().max(4096), z.array(z.string().max(1024)).max(64)]);
const reportSchema = z.object({ report: z.object({ protocol: z.literal(protocol), binding: bindingSchema,
  assertions: z.array(z.object({ node: learningIdentitySchema, expected: valueSchema, actual: valueSchema,
    status: z.literal('observed'), evidence: z.array(referenceSchema).min(1).max(64) }).strict()).max(100) }).strict(),
  receiptDigest: learningDigestSchema }).strict();
const checkerSchema = z.object({ scope: learningIdentitySchema, checkerId: learningIdentitySchema, providerId: learningIdentitySchema,
  version: learningIdentitySchema, authorizationFile: z.string(), allowLessonValidation: z.literal(true),
  qa: lessonQaConfigurationSchema, target: z.object({ ref: learningIdentitySchema, root: z.string(), path: z.string() }).strict(),
  evidence: z.array(z.object({ digest: learningDigestSchema, sources: z.array(z.object({ id: learningIdentitySchema,
    kind: z.enum(['audit', 'journal', 'session']), path: z.string(), allowedRoot: z.string(), runId: z.string().optional(),
  }).passthrough()).min(1).max(64) }).strict()).max(64).optional() }).strict();

type BlockedCode = 'candidate_unavailable' | 'stale_candidate' | 'invalid_receipt' | 'source_unavailable' | 'qa_not_independent'
  | 'configuration_unavailable' | 'authorization_changed' | 'audit_changed' | 'cancelled' | 'storage_unavailable';
class PublicationBlocked extends Error {
  constructor(readonly code: BlockedCode) { super(code); }
}
function fail(code: BlockedCode): never { throw new PublicationBlocked(code); }
const safePath = (file: string) => {
  if (!isAbsolute(file) || resolve(file) !== file || /[\0\r\n]/.test(file)) fail('configuration_unavailable');
};

function readFileSnapshot(file: string, root: string, limit: number, privateFile: boolean, check: () => void) {
  check();
  safePath(file);
  safePath(root);
  const location = relative(root, file);
  if (!location || isAbsolute(location) || location === '..' || location.startsWith(`..${sep}`)) fail('source_unavailable');
  assertKnowledgeDirectory(dirname(file));
  if (realpathSync(root) !== root || realpathSync(file) !== file) fail('source_unavailable');
  const parent = lstatSync(dirname(file));
  if (privateFile && ((parent.mode & 0o077) || (process.getuid && parent.uid !== process.getuid()))) fail('configuration_unavailable');
  const descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(descriptor);
    if (!before.isFile() || before.size > limit || (privateFile && (before.nlink !== 1 || (before.mode & 0o077)
      || (process.getuid && before.uid !== process.getuid())))) fail('source_unavailable');
    const bytes = Buffer.alloc(before.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      check();
      const count = readSync(descriptor, bytes, offset, Math.min(bytes.length - offset, 65536), offset);
      if (!count) break;
      offset += count;
    }
    const statKey = (stats: typeof before) => canonicalLearningJson([stats.dev, stats.ino, stats.size, stats.mode,
      stats.uid, stats.nlink, stats.mtimeMs, stats.ctimeMs]);
    const after = lstatSync(file);
    if (offset !== before.size || after.isSymbolicLink() || statKey(before) !== statKey(after)
      || statKey(before) !== statKey(fstatSync(descriptor)) || realpathSync(file) !== file) fail('source_unavailable');
    assertKnowledgeDirectory(dirname(file));
    const content = bytes.subarray(0, offset);
    check();
    return { bytes: content, fingerprint: digest([statKey(before), bytesDigest(content)]) };
  } finally { closeSync(descriptor); }
}

function redactAudit(value: unknown): unknown {
  if (typeof value === 'string') return redactEvidenceText(value);
  if (Array.isArray(value)) return value.map(redactAudit);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [redactEvidenceText(key),
    /^(?:[\w-]*(?:token|secret|password|passwd)|secrets|credentials|api[_-]?key|authorization|private[_-]?key|user(?:[_-]?(?:name|id))?|login|account(?:[_-]?(?:id|name))?|e[_-]?mail)$/i.test(key) ? '[redacted]' : redactAudit(entry)]));
  return value;
}

function auditReferences(bytes: Buffer, runId: string) {
  const history: RunEvent[] = [];
  const references: EvidenceRef[] = [];
  new TextDecoder('utf-8', { fatal: true }).decode(bytes).split('\n').forEach((line, index) => {
    if (!line.trim()) return;
    if (history.length >= 4096) fail('audit_changed');
    const event: RunEvent = JSON.parse(line);
    history.push(event);
    const position = { sourceId: 'lesson-qa', messageIndex: history.length, line: index + 1, auditSequence: event.sequence };
    const hash = digest({ content: canonicalLearningJson(redactAudit(event)), position, completeness: 'complete' });
    references.push({ id: `evidence:${hash}`, kind: 'audit', digest: hash, locator: `source:lesson-qa/messages/${history.length}`,
      completeness: 'complete', authority: 'observed' });
  });
  const integrity = verifyRunEventHistory(runId, history);
  if (!history.length || !integrity.valid || !integrity.lastHash) fail('audit_changed');
  return { history, references, integrity };
}

export interface LessonPublicationInput {
  store: CandidateStore;
  candidate: LearningCandidate;
  configurationFile?: string;
}

export type LessonPublicationResult = { status: 'blocked'; code: BlockedCode } | { status: 'current';
  binding: z.infer<typeof bindingSchema> & { validatedVersion: number }; evidence: EvidenceRef[] };

export function verifyLessonPublication(input: LessonPublicationInput, options: ProviderOperationOptions = {}): LessonPublicationResult {
  const check = () => { if (options.signal?.aborted) fail('cancelled'); };
  let failureCode: BlockedCode = 'storage_unavailable';
  try {
    check();
    const load = () => {
      check();
      const candidate = input.store.getCandidate(input.candidate.id);
      if (!candidate || !same(candidate, input.candidate)) fail('stale_candidate');
      if (candidate.state !== 'validated' && candidate.state !== 'published') fail('candidate_unavailable');
      const proposal = candidateProposalSchema.parse(candidate.proposal);
      if (proposal.kind !== 'lesson' || proposal.payload.rootCauseStatus !== 'confirmed' || digest(proposal) !== candidate.digest) fail('candidate_unavailable');
      const source = input.store.getRequest(candidate.requestKey);
      const request = distillationRequestSchema.parse(source?.request);
      if (!source || source.blockedReason || !request.sourceRunId || request.evidenceDigest !== candidate.evidenceDigest
        || request.scope !== proposal.applicability.project) fail('source_unavailable');
      return { candidate, proposal, source, request, attempts: input.store.listAnalysisAttempts(candidate.requestKey) };
    };
    const loaded = load();
    const { candidate, proposal, source, request } = loaded;
    const receipt = input.store.getValidation(candidate.id);
    const stored = validateEvidencePack(input.store.getEvidencePack(candidate.evidenceDigest));
    failureCode = 'invalid_receipt';
    if (!receipt?.passed || receipt.candidateId !== candidate.id || receipt.candidateDigest !== candidate.digest
      || receipt.evidenceDigest !== candidate.evidenceDigest || receipt.validatedVersion !== receipt.candidateVersion + 1
      || candidate.version !== receipt.validatedVersion + (candidate.state === 'published' ? 1 : 0)) fail('invalid_receipt');
    if (!receipt.results.length || receipt.results.length > 32 || receipt.results.some(chunk => !/^json-base64-v1:[A-Za-z0-9+/]+={0,2}$/.test(chunk)
      || chunk.length > 1815)) fail('invalid_receipt');
    const encoded = receipt.results.map(chunk => chunk.slice('json-base64-v1:'.length)).join('');
    const decoded = Buffer.from(encoded, 'base64');
    if (decoded.length > DISTILLATION_LIMITS.outputBytes || decoded.toString('base64') !== encoded) fail('invalid_receipt');
    const envelope = reportSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(decoded)));
    const { binding, assertions } = envelope.report;
    const qa = binding.qa;
    if (digest(envelope.report) !== envelope.receiptDigest || receipt.validatorVersion !== `${protocol}:${binding.executionId}`
      || !same([binding.candidateId, binding.candidateVersion, binding.candidateDigest, binding.evidenceDigest, binding.scope],
        [candidate.id, receipt.candidateVersion, candidate.digest, candidate.evidenceDigest, request.scope])
      || !same([qa.candidateId, qa.candidateVersion, qa.candidateDigest, qa.evidenceDigest, qa.scope, qa.workItemId],
        [candidate.id, receipt.candidateVersion, candidate.digest, candidate.evidenceDigest, request.scope, request.workItemId])
      || binding.target.scope !== request.scope || binding.target.ref !== proposal.targetRef) fail('invalid_receipt');
    if (request.sourceRunId === qa.qaRunId || loaded.attempts.some(attempt => attempt.analysisRunId === qa.qaRunId || attempt.sessionId === qa.qaRunId)) fail('qa_not_independent');
    const storedRefs = new Map(stored.entries.map(entry => [entry.ref.id, entry.ref]));
    if (stored.digest !== candidate.evidenceDigest || stored.completeness !== 'complete' || source.evidence.length !== storedRefs.size
      || source.evidence.some(ref => !same(ref, storedRefs.get(ref.id) ?? null))) fail('source_unavailable');
    for (const entry of stored.entries.filter(entry => entry.ref.authority === 'observed')) {
      const event = JSON.parse(entry.content);
      if (event.context?.runId !== request.sourceRunId || event.context?.workItemId !== request.workItemId
        || event.context?.purpose === 'learning') fail('source_unavailable');
    }
    const refs = proposal.evidenceIds.map(id => stored.entries.find(entry => entry.ref.id === id)?.ref);
    if (!refs.length || refs.some(ref => ref?.authority !== 'observed' || ref.completeness !== 'complete')) fail('source_unavailable');
    failureCode = 'configuration_unavailable';
    if (!input.configurationFile) fail('configuration_unavailable');
    const pins: Array<{ file: string; root: string; limit: number; privateFile: boolean; fingerprint: string }> = [];
    const readPinned = (file: string, root: string, limit: number, privateFile = false) => {
      const snapshot = readFileSnapshot(file, root, limit, privateFile, check);
      pins.push({ file, root, limit, privateFile, fingerprint: snapshot.fingerprint });
      return snapshot;
    };
    const configuration = readPinned(input.configurationFile, dirname(input.configurationFile), 1024 * 1024, true);
    if (configuration.fingerprint !== binding.configurationDigest) fail('configuration_unavailable');
    const config = z.object({ version: z.literal(1), checkers: z.array(z.unknown()).min(1).max(64) }).strict()
      .parse(JSON.parse(configuration.bytes.toString('utf8')));
    const matches = config.checkers.filter(entry => {
      const identity = z.object({ scope: z.string(), checkerId: z.string() }).safeParse(entry);
      return identity.success && identity.data.scope === binding.scope && identity.data.checkerId === binding.checkerId;
    });
    if (matches.length !== 1) fail('configuration_unavailable');
    const checker = checkerSchema.parse(matches[0]);
    if (checker.version !== binding.checkerVersion || checker.target.ref !== binding.target.ref || !same(checker.qa,
      { scope: qa.scope, workItemId: qa.workItemId, runId: qa.qaRunId, targetRevision: qa.targetRevision, root: checker.qa.root, auditDigest: qa.auditDigest })) fail('configuration_unavailable');
    failureCode = 'authorization_changed';
    const grantSnapshot = readPinned(checker.authorizationFile, dirname(checker.authorizationFile), 1024 * 1024, true);
    const grant = readKnowledgeGrant(checker.authorizationFile);
    const authorizationReads = new Map<string, string | null>();
    readKnowledgeAuthorization({ authorizationFile: checker.authorizationFile, policy: grant.policy, signal: options.signal }, false, authorizationReads);
    if (grant.policy.scope !== request.scope || !grant.policy.targets.some(target => target.ref === binding.target.ref && target.kinds.includes('lesson'))
      || digest([configuration.fingerprint, grantSnapshot.fingerprint, grant]) !== binding.authorizationDigest) fail('authorization_changed');
    failureCode = 'source_unavailable';
    const identity = { scope: request.scope, runId: request.sourceRunId!, analyzerVersion: request.analyzerVersion };
    const cursor = input.store.getScanCursor(identity);
    let sources = checker.evidence?.find(entry => entry.digest === candidate.evidenceDigest)?.sources;
    if (cursor) {
      const root = input.store.getScanSourceRoot(identity);
      if (!root || !input.store.getScanRequestKeys(identity).includes(source.key)) fail('source_unavailable');
      const path = new JsonlEventStore({ root }).pathFor(identity.runId);
      const snapshot = readPinned(path, root, 64 * 1024 * 1024);
      const audit = auditReferences(snapshot.bytes, identity.runId);
      if (audit.history[cursor.sequence - 1]?.integrity.hash !== cursor.head) fail('source_unavailable');
      const recorded = audit.history.flatMap(event => event.data.kind === 'agent.session_recorded' ? [event.data] : []);
      const sessions = [...new Map(recorded.map(session => [session.sessionId, session])).values()]
        .sort((first, second) => first.sessionId < second.sessionId ? -1 : first.sessionId > second.sessionId ? 1 : 0);
      if (sessions.length > 63) fail('source_unavailable');
      const home = realpathSync(homedir());
      const roots = [join(home, '.afk', 'transcripts'), join(home, '.claude', 'projects'), join(home, '.codex', 'sessions'), join(home, '.codex', 'archived_sessions')];
      sources = [{ id: 'audit-1', kind: 'audit', path, allowedRoot: root, runId: identity.runId }, ...sessions.map((session, index) => {
        const path = session.transcriptPath;
        if (!path) fail('source_unavailable');
        safePath(path);
        const allowedRoot = roots.find(root => path.startsWith(`${root}${sep}`));
        if (!allowedRoot) fail('source_unavailable');
        return { id: `session-${index + 1}`, kind: 'session' as const, path, allowedRoot };
      })];
    }
    if (!sources || sources.length !== stored.sources.length || new Set(sources.map(source => source.id)).size !== sources.length) fail('source_unavailable');
    for (const entry of sources) {
      const expected = stored.sources.find(source => source.id === entry.id);
      if (!expected?.sourceDigest || expected.kind !== entry.kind || expected.completeness !== 'complete'
        || (entry.kind === 'audit' && entry.runId !== request.sourceRunId)
        || bytesDigest(readPinned(entry.path, entry.allowedRoot, 64 * 1024 * 1024).bytes) !== expected.sourceDigest) fail('source_unavailable');
    }
    const targetDigest = bytesDigest(readPinned(join(checker.target.root, checker.target.path), checker.target.root, DISTILLATION_LIMITS.evidenceBytes).bytes);
    if (binding.target.snapshotDigest !== targetDigest || binding.target.revision !== `sha256:${targetDigest}`) fail('source_unavailable');
    failureCode = 'audit_changed';
    const audit = readPinned(new JsonlEventStore({ root: checker.qa.root }).pathFor(qa.qaRunId), checker.qa.root, DISTILLATION_LIMITS.evidenceBytes);
    if (bytesDigest(audit.bytes) !== qa.auditDigest) fail('audit_changed');
    const observed = auditReferences(audit.bytes, qa.qaRunId);
    if (observed.integrity.lastHash !== qa.auditHead || observed.integrity.lastSequence !== qa.auditSequence
      || new Set(binding.qaEvidence.map(ref => ref.id)).size !== 5) fail('invalid_receipt');
    for (const ref of binding.qaEvidence) {
      const index = observed.references.findIndex(actual => same(actual, ref));
      const event = observed.history[index];
      if (!event || event.context.workItemId !== qa.workItemId || event.context.actor.kind !== 'system'
        || event.context.purpose === 'learning' || event.type !== event.data.kind) fail('invalid_receipt');
    }
    const selected = binding.qaEvidence.map(ref => observed.history[observed.references.findIndex(actual => actual.id === ref.id)]);
    if (!['qa.started', 'qa.passed', 'commit.recorded', 'decision.made'].every(kind => selected.some(event => event.data.kind === kind))
      || !selected.some(event => ['run.finished', 'human_gate.opened', 'change.merge_verified'].includes(event.data.kind))) fail('invalid_receipt');
    const commit = selected.find(event => event.data.kind === 'commit.recorded')!;
    const target = selected.find(event => event.data.kind === 'decision.made')!;
    if (commit.data.kind !== 'commit.recorded' || commit.data.phase !== 'qa' || commit.data.commitSha !== qa.targetRevision
      || target.data.kind !== 'decision.made' || target.data.command !== 'experience.qa-target' || !target.data.accepted
      || !target.data.reason) fail('invalid_receipt');
    const pinnedTarget = JSON.parse(target.data.reason);
    if (pinnedTarget.target?.project !== qa.scope || pinnedTarget.target?.revision !== qa.targetRevision
      || pinnedTarget.target?.dirty !== false) fail('invalid_receipt');
    const shortRef = (ref: EvidenceRef) => ({ id: ref.id, digest: ref.digest, locator: ref.locator });
    const sourceRefs = refs.map(ref => shortRef(ref!));
    const qaRefs = binding.qaEvidence.map(shortRef);
    const expected = { ...proposal.payload, project: proposal.applicability.project, environments: proposal.applicability.environments,
      versions: proposal.applicability.versions, applicabilityPreconditions: proposal.applicability.preconditions,
      exclusions: proposal.applicability.exclusions, invalidationConditions: proposal.applicability.invalidationConditions, fixTargetRevision: qa.targetRevision };
    if (assertions.length !== Object.keys(expected).length || new Set(assertions.map(assertion => assertion.node)).size !== assertions.length) fail('invalid_receipt');
    for (const [key, value] of Object.entries(expected)) {
      const assertion = assertions.find(assertion => assertion.node === `lesson.${key}`);
      const evidence = key === 'fixTargetRevision' ? qaRefs : key === 'fix' || key === 'prevention' ? [...sourceRefs, ...qaRefs] : sourceRefs;
      if (!assertion || !same(assertion.expected, value) || !same(assertion.actual, value) || !same(assertion.evidence, evidence)) fail('invalid_receipt');
    }
    for (const pin of pins) {
      if (readFileSnapshot(pin.file, pin.root, pin.limit, pin.privateFile, check).fingerprint !== pin.fingerprint) fail('source_unavailable');
    }
    failureCode = 'storage_unavailable';
    const current = load();
    if (current.attempts.some(attempt => attempt.analysisRunId === qa.qaRunId || attempt.sessionId === qa.qaRunId)) fail('qa_not_independent');
    if (!same(current.source, source) || !same(input.store.getValidation(candidate.id), receipt)) fail('stale_candidate');
    failureCode = 'authorization_changed';
    for (const [path, expected] of authorizationReads) {
      let observed: string | null;
      try {
        observed = bytesDigest(readFileSnapshot(knowledgeFile(grant.policy.vault, path), grant.policy.vault,
          KNOWLEDGE_FILE_BYTES, false, check).bytes);
      } catch (error) {
        if ((error as NodeJS.ErrnoException | null)?.code !== 'ENOENT') throw error;
        observed = null;
      }
      if (observed !== expected) fail('authorization_changed');
    }
    check();
    return { status: 'current', binding: { ...binding, validatedVersion: receipt.validatedVersion }, evidence: binding.qaEvidence };
  } catch (error) {
    return { status: 'blocked', code: options.signal?.aborted ? 'cancelled' : error instanceof PublicationBlocked ? error.code : failureCode };
  }
}

export function assertCurrentLessonPublication(input: LessonPublicationInput): void {
  const result = verifyLessonPublication(input);
  if (result.status === 'blocked') throw new Error(`lesson_publication_${result.code}`);
}
