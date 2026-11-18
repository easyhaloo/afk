import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { realpathSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import type { RunEvent } from '@afk/core';
import { z } from 'zod';
import { JsonlEventStore, verifyRunEventHistory } from '../../infrastructure/observability/jsonl-event-store.js';
import type { ProviderOperationOptions } from '../../plugin-sdk/capabilities.js';
import type { CandidateStore, LearningCandidate } from './candidate-store.js';
import { candidateProposalSchema, distillationRequestSchema, DISTILLATION_LIMITS, learningScopeSchema } from './contracts.js';
import { matchesEvidenceWorkItem, validateEvidencePack, type EvidenceSourceInput } from './evidence.js';
import { KNOWLEDGE_FILE_BYTES, knowledgeFile, readKnowledgeAuthorization, readKnowledgeGrant } from './knowledge.js';
import { canonicalLearningJson, learningDigestSchema, learningIdentitySchema } from './requests.js';
import { successfulRunEvidenceFromEvents } from './run-evidence.js';
import type { CheckSourceRead } from './source-read-grant.js';
import { selectKnowledgeValidationChecker, validationConfigurationSchema } from './validation-configuration.js';
import { readValidationPrivateFile, readValidationSnapshotFile } from './validation-files.js';

const protocol = 'learning-validation-v1';
const bytesDigest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const digest = (value: unknown) => bytesDigest(canonicalLearningJson(value));
const same = (first: unknown, second: unknown) => canonicalLearningJson(first) === canonicalLearningJson(second);
const version = z.number().int().positive().safe();
const referenceSchema = z.object({ id: learningIdentitySchema, digest: learningDigestSchema, locator: learningIdentitySchema }).strict();
const valueSchema = z.union([z.string().max(4096), z.array(z.string().max(1024)).max(64)]);
const factAuthoritySchema = z.object({ scope: learningScopeSchema, targetRef: learningIdentitySchema,
  subject: z.string().min(1).max(512), rule: z.string().min(1).max(4096), version: learningIdentitySchema,
  environment: learningIdentitySchema.optional(), validUntil: z.string().datetime({ offset: true })
    .transform(value => Date.parse(value)).pipe(z.number().finite()),
}).strict();
const envelopeSchema = z.object({ report: z.object({ protocol: z.literal(protocol), binding: z.object({
  scope: learningScopeSchema, candidateId: learningDigestSchema, candidateVersion: version, candidateDigest: learningDigestSchema,
  evidenceDigest: learningDigestSchema, checkerId: learningIdentitySchema, checkerVersion: learningIdentitySchema,
  configurationDigest: learningDigestSchema, authorizationDigest: learningDigestSchema, executionId: z.string().uuid(),
  target: z.object({ scope: learningScopeSchema, ref: learningIdentitySchema, revision: learningIdentitySchema,
    snapshotDigest: learningDigestSchema }).strict(),
}).strict(), assertions: z.array(z.object({ node: learningIdentitySchema, expected: valueSchema, actual: valueSchema,
  status: z.literal('observed'), evidence: z.array(referenceSchema).min(1).max(64) }).strict()).max(100) }).strict(),
receiptDigest: learningDigestSchema }).strict();

export interface KnowledgePublicationInput {
  checkSourceRead?: CheckSourceRead;
  recall?: { version?: string; environment?: string };
  store: CandidateStore;
  candidate: LearningCandidate;
  configurationFile?: string;
  checkerId?: string;
  homeDir?: string;
}

export function assertCurrentKnowledgePublication(input: KnowledgePublicationInput, options: ProviderOperationOptions = {}): void {
  function fail(code: string): never { throw new Error(`knowledge_publication_${code}`); }
  const check = () => {
    if (options.signal?.aborted) fail('cancelled');
    if (options.deadlineAt !== undefined && Date.now() >= options.deadlineAt) fail('timed_out');
  };
  let failureCode = 'storage_unavailable';
  try {
    const load = () => {
      check();
      const candidate = input.store.getCandidate(input.candidate.id);
      if (!candidate || !same(candidate, input.candidate)) fail('stale_candidate');
      if (candidate.state !== 'validated' && candidate.state !== 'published') fail('candidate_unavailable');
      const proposal = candidateProposalSchema.parse(candidate.proposal);
      if (proposal.kind !== 'fact' && proposal.kind !== 'process') fail('unsupported_kind');
      if (digest(proposal) !== candidate.digest) fail('candidate_unavailable');
      if (proposal.kind === 'fact' && proposal.payload.classification !== 'fact') fail('candidate_unavailable');
      if (proposal.kind === 'process' && (new Set(proposal.payload.steps.map(step => step.id)).size !== proposal.payload.steps.length
        || proposal.payload.steps.some(step => step.missingEvidence !== undefined || !step.evidenceIds.length))) fail('source_unavailable');
      const source = input.store.getRequest(candidate.requestKey);
      const request = distillationRequestSchema.parse(source?.request);
      if (!source || source.blockedReason || request.evidenceDigest !== candidate.evidenceDigest
        || request.scope !== proposal.applicability.project) fail('source_unavailable');
      return { candidate, proposal, source, request };
    };
    const loaded = load();
    const { candidate, proposal, source, request } = loaded;
    failureCode = 'invalid_receipt';
    const receipt = input.store.getValidation(candidate.id);
    if (!receipt?.passed || receipt.candidateId !== candidate.id || receipt.candidateDigest !== candidate.digest
      || receipt.evidenceDigest !== candidate.evidenceDigest || !version.safeParse(receipt.candidateVersion).success
      || !version.safeParse(receipt.validatedVersion).success || receipt.validatedVersion !== receipt.candidateVersion + 1
      || candidate.version !== receipt.validatedVersion + (candidate.state === 'published' ? 1 : 0)) fail('invalid_receipt');
    if (!receipt.results.length || receipt.results.length > 32 || receipt.results.some(chunk =>
      !/^json-base64-v1:[A-Za-z0-9+/]+={0,2}$/.test(chunk) || chunk.length > 1815)) fail('invalid_receipt');
    const encoded = receipt.results.map(chunk => chunk.slice('json-base64-v1:'.length)).join('');
    const decoded = Buffer.from(encoded, 'base64');
    if (decoded.length > DISTILLATION_LIMITS.outputBytes || decoded.toString('base64') !== encoded) fail('invalid_receipt');
    const envelope = envelopeSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(decoded)));
    const { binding, assertions } = envelope.report;
    if (input.checkerId !== undefined && input.checkerId !== binding.checkerId) fail('checker_mismatch');
    if (digest(envelope.report) !== envelope.receiptDigest || receipt.validatorVersion !== `${protocol}:${binding.executionId}`
      || !same([binding.scope, binding.candidateId, binding.candidateVersion, binding.candidateDigest, binding.evidenceDigest],
        [request.scope, candidate.id, receipt.candidateVersion, candidate.digest, candidate.evidenceDigest])
      || binding.target.scope !== request.scope || binding.target.ref !== proposal.targetRef) fail('invalid_receipt');

    failureCode = 'source_unavailable';
    const stored = validateEvidencePack(input.store.getEvidencePack(candidate.evidenceDigest));
    const refs = new Map(stored.entries.map(entry => [entry.ref.id, entry.ref]));
    if (stored.digest !== candidate.evidenceDigest || stored.completeness !== 'complete' || source.evidence.length !== refs.size
      || new Set(source.evidence.map(ref => ref.id)).size !== refs.size
      || source.evidence.some(ref => !same(ref, refs.get(ref.id) ?? null))) fail('source_unavailable');
    if (!request.sourceRunId) fail('source_unavailable');
    for (const entry of stored.entries.filter(entry => entry.ref.authority === 'observed')) {
      const event = JSON.parse(entry.content);
      if (event.context?.runId !== request.sourceRunId || !matchesEvidenceWorkItem(entry, event.context?.workItemId, request.workItemId)
        || event.context?.purpose === 'learning') fail('source_unavailable');
    }
    const required: Array<{ node: string; expected: z.infer<typeof valueSchema>; evidence: z.infer<typeof referenceSchema>[] }> = [];
    const add = (node: string, expected: z.infer<typeof valueSchema>, ids = proposal.evidenceIds) => {
      const evidence = ids.map(id => {
        const ref = refs.get(id);
        if (!ref || ref.authority !== 'observed' || ref.completeness !== 'complete') fail('source_unavailable');
        return { id: ref.id, digest: ref.digest, locator: ref.locator };
      });
      required.push({ node, expected, evidence });
    };
    if (proposal.kind === 'fact') {
      add('fact.subject', proposal.payload.subject);
      add('fact.rule', proposal.payload.rule);
      add('fact.authority', proposal.evidenceIds.map(id => {
        const ref = refs.get(id);
        if (!ref) fail('source_unavailable');
        return ref.locator;
      }).sort());
    } else if (proposal.kind === 'process') {
      add('process.entry', proposal.payload.entry);
      for (const field of ['preconditions', 'exclusions', 'invalidationConditions'] as const) {
        add(`process.applicability.${field}`, proposal.applicability[field]);
      }
      add('process.systems', proposal.payload.systems);
      add('process.preconditions', proposal.payload.preconditions);
      add('process.stepCount', String(proposal.payload.steps.length));
      proposal.payload.steps.forEach((step, index) => {
        add(`process.steps.${index}.action`, step.action, step.evidenceIds);
        add(`process.steps.${index}.stateChange`, step.stateChange, step.evidenceIds);
      });
      add('process.exceptions', proposal.payload.exceptions);
      add('process.completion', proposal.payload.completion);
    }
    if (assertions.length !== required.length || new Set(assertions.map(assertion => assertion.node)).size !== required.length
      || required.some(expected => {
        const actual = assertions.find(assertion => assertion.node === expected.node);
        return !actual || !same(actual.expected, expected.expected) || !same(actual.actual, expected.expected)
          || !same(actual.evidence, expected.evidence);
      })) fail('invalid_receipt');

    failureCode = 'configuration_unavailable';
    if (!input.configurationFile) fail('configuration_unavailable');
    const privatePins = new Map<string, string>();
    const readPrivate = (file: string) => {
      check();
      const snapshot = readValidationPrivateFile(file);
      if (privatePins.has(file) && privatePins.get(file) !== snapshot.fingerprint) fail('configuration_unavailable');
      privatePins.set(file, snapshot.fingerprint);
      return snapshot;
    };
    const pins: Array<{ file: string; root: string; limit: number; digest: string }> = [];
    const readSnapshot = (file: string, root: string, limit: number) => {
      check();
      input.checkSourceRead?.(file);
      const bytes = readValidationSnapshotFile(file, root, limit);
      pins.push({ file, root, limit, digest: bytesDigest(bytes) });
      return bytes;
    };
    const configuration = readPrivate(input.configurationFile);
    if (configuration.fingerprint !== binding.configurationDigest) fail('configuration_unavailable');
    const config = validationConfigurationSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(configuration.bytes)));
    const checker = selectKnowledgeValidationChecker(config, binding.scope, binding.checkerId);
    if (!checker) fail('configuration_unavailable');
    if ('mode' in checker && checker.mode === 'fact-command') fail('unsupported_fact_command');
    if (checker.version !== binding.checkerVersion || checker.target.ref !== binding.target.ref || checker.qa) fail('configuration_unavailable');
    failureCode = 'authorization_changed';
    const authorization = readPrivate(checker.authorizationFile);
    const grant = readKnowledgeGrant(checker.authorizationFile);
    const authorizationReads = new Map<string, string | null>();
    readKnowledgeAuthorization({ authorizationFile: checker.authorizationFile, policy: grant.policy, signal: options.signal }, false, authorizationReads);
    if (grant.policy.scope !== request.scope || !grant.policy.targets.some(target => target.ref === binding.target.ref
      && target.kinds.some(kind => kind === proposal.kind))
      || digest([configuration.fingerprint, authorization.fingerprint, grant]) !== binding.authorizationDigest) fail('authorization_changed');
    readPrivate(checker.authorizationFile);

    failureCode = 'source_unavailable';
    let sources: EvidenceSourceInput[] | undefined = checker.evidence?.find(entry => entry.digest === candidate.evidenceDigest)?.sources;
    const identity = request.sourceRunId ? { scope: request.scope, runId: request.sourceRunId, analyzerVersion: request.analyzerVersion } : undefined;
    const cursor = identity && input.store.getScanCursor(identity);
    let scanRoot: string | undefined;
    if (identity && cursor) {
      const root = input.store.getScanSourceRoot(identity);
      if (!root || !input.store.getScanRequestKeys(identity).includes(source.key)) fail('source_unavailable');
      scanRoot = root;
      const path = new JsonlEventStore({ root }).pathFor(identity.runId);
      const bytes = readSnapshot(path, root, 64 * 1024 * 1024);
      const history: RunEvent[] = new TextDecoder('utf-8', { fatal: true }).decode(bytes).split('\n').filter(line => line.trim()).map(line => JSON.parse(line));
      if (!verifyRunEventHistory(identity.runId, history).valid || history[cursor.sequence - 1]?.integrity.hash !== cursor.head) fail('source_unavailable');
      successfulRunEvidenceFromEvents({ scope: request.scope, runId: identity.runId, workItemId: request.workItemId, evidence: [] }, history);
      const sessions = [...new Map(history.flatMap(event => event.data.kind === 'agent.session_recorded' ? [event.data] : [])
        .map(session => [session.sessionId, session])).values()].sort((first, second) => first.sessionId < second.sessionId ? -1 : first.sessionId > second.sessionId ? 1 : 0);
      if (sessions.length > 63) fail('source_unavailable');
      const home = realpathSync(input.homeDir ?? homedir());
      const roots = [join(home, '.afk', 'transcripts'), join(home, '.claude', 'projects'), join(home, '.codex', 'sessions'), join(home, '.codex', 'archived_sessions')];
      sources = [{ id: 'audit-1', kind: 'audit', path, allowedRoot: root, runId: identity.runId }, ...sessions.map((session, index) => {
        const path = session.transcriptPath;
        if (!path) fail('source_unavailable');
        const allowedRoot = roots.find(root => {
          const location = relative(root, path);
          return location !== '' && !isAbsolute(location) && location !== '..' && !location.startsWith(`..${sep}`);
        });
        if (!allowedRoot) fail('source_unavailable');
        return { id: `session-${index + 1}`, kind: 'session' as const, path, allowedRoot };
      })];
    }
    if (!sources || sources.length !== stored.sources.length || new Set(sources.map(entry => entry.id)).size !== sources.length) fail('source_unavailable');
    for (const entry of sources) {
      const expected = stored.sources.find(source => source.id === entry.id);
      if (!expected?.sourceDigest || expected.kind !== entry.kind || expected.completeness !== 'complete'
        || (entry.kind === 'audit' && request.sourceRunId && entry.runId !== request.sourceRunId)
        || bytesDigest(readSnapshot(entry.path, entry.allowedRoot, 64 * 1024 * 1024)) !== expected.sourceDigest) fail('source_unavailable');
    }
    const targetDigest = bytesDigest(readSnapshot(join(checker.target.root, checker.target.path), checker.target.root, DISTILLATION_LIMITS.evidenceBytes));
    if (binding.target.snapshotDigest !== targetDigest || binding.target.revision !== `sha256:${targetDigest}`) fail('target_changed');
    const recall = input.recall;
    const fact = proposal.kind === 'fact' ? proposal.payload : undefined;
    const authorities = recall && fact && checker.factAuthorityPaths?.map(path => {
      const bytes = readSnapshot(join(checker.target.root, path), checker.target.root, DISTILLATION_LIMITS.evidenceBytes);
      const record = factAuthoritySchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
      if (record.scope !== binding.scope || record.targetRef !== binding.target.ref || record.subject !== fact.subject) fail('authority_mismatch');
      return record;
    });
    for (const pin of pins) {
      check();
      input.checkSourceRead?.(pin.file);
      if (bytesDigest(readValidationSnapshotFile(pin.file, pin.root, pin.limit)) !== pin.digest) fail('source_unavailable');
    }
    failureCode = 'configuration_unavailable';
    for (const [file, fingerprint] of privatePins) {
      check();
      if (readValidationPrivateFile(file).fingerprint !== fingerprint) fail(file === checker.authorizationFile ? 'authorization_changed' : 'configuration_unavailable');
    }
    failureCode = 'authorization_changed';
    for (const [path, expected] of authorizationReads) {
      check();
      let actual: string | null;
      try { actual = bytesDigest(readValidationSnapshotFile(knowledgeFile(grant.policy.vault, path), grant.policy.vault, KNOWLEDGE_FILE_BYTES)); }
      catch (error) {
        if ((error as NodeJS.ErrnoException | null)?.code !== 'ENOENT') throw error;
        actual = null;
      }
      if (actual !== expected) fail('authorization_changed');
    }
    failureCode = 'storage_unavailable';
    if (!same(load(), loaded) || !same(input.store.getValidation(candidate.id), receipt)
      || !same(input.store.getEvidencePack(candidate.evidenceDigest), stored)
      || (identity && (!same(input.store.getScanCursor(identity) ?? null, cursor ?? null)
        || (cursor && (input.store.getScanSourceRoot(identity) !== scanRoot
          || !input.store.getScanRequestKeys(identity).includes(source.key)))))) fail('stale_candidate');
    if (authorities && recall && fact) {
      const now = Date.now();
      const applicable = authorities.filter(record => record.validUntil > now && record.version === recall.version);
      if (recall.environment === undefined && applicable.some(record => record.environment !== undefined)) fail('authority_unconfirmed');
      const current = applicable.filter(record => record.environment === undefined || record.environment === recall.environment);
      if (!current.length || current.some(record => record.rule !== fact.rule)) fail('authority_unconfirmed');
    }
    check();
  } catch (error) {
    if (error instanceof Error && /^knowledge_publication_[a-z_]+$/.test(error.message)) throw error;
    check();
    fail(failureCode);
  }
}
