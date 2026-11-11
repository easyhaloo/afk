import { createHash } from 'node:crypto';
import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { performance } from 'node:perf_hooks';
import type { RunEvent } from '@afk/core';
import { z } from 'zod';
import { JsonlEventStore, verifyRunEventHistory } from '../../infrastructure/observability/jsonl-event-store.js';
import { checkAbort } from '../../infrastructure/providers/dependencies.js';
import type { ProviderOperationOptions, VerificationProvider } from '../../plugin-sdk/capabilities.js';
import { CandidateStore, type LearningCandidate } from './candidate-store.js';
import { DISTILLATION_LIMITS, learningScopeSchema } from './contracts.js';
import { buildEvidencePack, readEvidenceSource, type EvidenceSourceInput } from './evidence.js';
import { assertKnowledgeDirectory, readKnowledgeAuthorization, readKnowledgeGrant } from './knowledge.js';
import { canonicalLearningJson, learningDigestSchema, learningIdentitySchema } from './requests.js';
import { successfulRunEvidenceFromEvents } from './runtime.js';
import { validateLearningCandidate, type LearningValidationChecker, type LearningValidationDependencies, type LearningValidationResult } from './validation.js';

const savedPath = z.string().min(1).max(4096).refine(value => isAbsolute(value) && resolve(value) === value && !/[\0\r\n]/.test(value));
const relativePath = z.string().min(1).max(4096).refine(value => !isAbsolute(value) && !/[\\\0\r\n]/.test(value)
  && !value.split('/').some(part => !part || part === '.' || part === '..'));
const sourceSchema = z.object({ id: learningIdentitySchema, kind: z.enum(['audit', 'journal', 'session']), path: savedPath,
  allowedRoot: savedPath, provider: z.enum(['claude-code', 'codex', 'opencode']).optional(),
  format: z.enum(['jsonl', 'json', 'text']).optional(), runId: learningIdentitySchema.optional(),
  range: z.object({ start: z.number().int().positive(), end: z.number().int().positive() }).strict()
    .refine(value => value.end >= value.start).optional(),
}).strict().refine(value => value.kind !== 'audit' || value.runId !== undefined);
const checkerIdentitySchema = z.object({ scope: learningScopeSchema, checkerId: learningIdentitySchema,
  providerId: learningIdentitySchema, version: learningIdentitySchema }).strict();
const checkerSchema = checkerIdentitySchema.extend({ authorizationFile: savedPath,
  target: z.object({ ref: learningIdentitySchema, root: savedPath, path: relativePath }).strict(),
  evidence: z.array(z.object({ digest: learningDigestSchema, sources: z.array(sourceSchema).min(1).max(64)
    .refine(sources => new Set(sources.map(source => source.id)).size === sources.length) }).strict()).min(1).max(64)
    .refine(entries => new Set(entries.map(entry => entry.digest)).size === entries.length).optional(),
}).strict();
export const validationConfigurationSchema = z.object({ version: z.literal(1), checkers: z.array(checkerSchema).min(1).max(64)
  .refine(checkers => new Set(checkers.map(checker => canonicalLearningJson([checker.scope, checker.checkerId]))).size === checkers.length),
}).strict();
const inputSchema = z.object({ scope: learningScopeSchema, candidateId: learningDigestSchema,
  expectedVersion: z.number().int().positive().safe(), checkerId: learningIdentitySchema }).strict();

export type ValidationConfiguration = z.infer<typeof validationConfigurationSchema>;
export type ValidationProviderBinding = z.infer<typeof checkerIdentitySchema> & { snapshot: { path: string; content: string } };
export interface ValidationRuntimeOptions extends ProviderOperationOptions {
  file: string;
  configurationFile: string;
  resolveProvider(binding: ValidationProviderBinding, options: ProviderOperationOptions): Promise<VerificationProvider | undefined>;
  timeoutMs?: number;
}

const bytesDigest = (input: Buffer) => createHash('sha256').update(input).digest('hex');
const digest = (input: unknown) => createHash('sha256').update(canonicalLearningJson(input)).digest('hex');

function readSnapshotFile(file: string, root: string, limit: number): Buffer {
  savedPath.parse(file);
  savedPath.parse(root);
  const location = relative(root, file);
  if (!location || isAbsolute(location) || location === '..' || location.startsWith(`..${sep}`)) throw new Error('snapshot_outside_root');
  assertKnowledgeDirectory(dirname(file));
  if (realpathSync(root) !== root || realpathSync(file) !== file) throw new Error('snapshot_unsafe_path');
  const descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(descriptor);
    if (!before.isFile() || before.size > limit) throw new Error('snapshot_unavailable');
    const bytes = Buffer.alloc(before.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (!count) break;
      offset += count;
    }
    const fingerprint = (stats: typeof before) => canonicalLearningJson([stats.dev, stats.ino, stats.size, stats.mode,
      stats.uid, stats.nlink, stats.mtimeMs, stats.ctimeMs]);
    const current = lstatSync(file);
    if (offset !== before.size || current.isSymbolicLink() || fingerprint(before) !== fingerprint(fstatSync(descriptor))
      || fingerprint(before) !== fingerprint(current) || realpathSync(file) !== file) throw new Error('snapshot_changed');
    assertKnowledgeDirectory(dirname(file));
    return bytes.subarray(0, offset);
  } finally { closeSync(descriptor); }
}

function readPrivateFile(file: string): { bytes: Buffer; fingerprint: string } {
  savedPath.parse(file);
  assertKnowledgeDirectory(dirname(file));
  const parent = lstatSync(dirname(file));
  if ((parent.mode & 0o077) || (process.getuid && parent.uid !== process.getuid())) throw new Error('private_file_required');
  const descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(descriptor);
    if (!before.isFile() || before.nlink !== 1 || before.size > 1024 * 1024 || (before.mode & 0o077)
      || (process.getuid && before.uid !== process.getuid())) throw new Error('private_file_required');
    const buffer = Buffer.alloc(before.size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const count = readSync(descriptor, buffer, offset, buffer.length - offset, offset);
      if (!count) break;
      offset += count;
    }
    const fingerprint = (stats: typeof before) => canonicalLearningJson([stats.dev, stats.ino, stats.size, stats.mode,
      stats.uid, stats.nlink, stats.mtimeMs, stats.ctimeMs]);
    const after = lstatSync(file);
    if (offset !== before.size || after.isSymbolicLink() || fingerprint(before) !== fingerprint(fstatSync(descriptor))
      || fingerprint(before) !== fingerprint(after)) throw new Error('private_file_changed');
    assertKnowledgeDirectory(dirname(file));
    const bytes = buffer.subarray(0, offset);
    return { bytes, fingerprint: digest([fingerprint(before), bytesDigest(bytes)]) };
  } finally { closeSync(descriptor); }
}

export async function validateConfiguredLearningCandidate(input: unknown, options: ValidationRuntimeOptions): Promise<LearningValidationResult> {
  const began = performance.now();
  const parsed = inputSchema.safeParse(input);
  const timeout = z.number().int().positive().max(DISTILLATION_LIMITS.timeoutMs)
    .safeParse(options.timeoutMs === undefined ? DISTILLATION_LIMITS.timeoutMs : options.timeoutMs);
  if (!parsed.success || !timeout.success) return { status: 'blocked', code: 'invalid_input' };
  const deadline = began + timeout.data;
  let expired = false;
  const checkBudget = (operation: ProviderOperationOptions = {}) => {
    if (performance.now() >= deadline) { expired = true; throw new Error('validation_deadline_exceeded'); }
    checkAbort(operation);
  };
  if (options.signal?.aborted) return { status: 'blocked', code: 'cancelled' };
  let store: CandidateStore | undefined;
  try {
    checkBudget(options);
    savedPath.parse(options.file);
    savedPath.parse(options.configurationFile);
    const exists = existsSync(options.file);
    checkBudget(options);
    if (!exists) return { status: 'blocked', code: 'candidate_unavailable' };
    store = new CandidateStore({ file: options.file });
    checkBudget(options);
    const ledger = store;
    const pinned = new Map<string, string>();
    const readPinned = (file: string) => {
      const current = readPrivateFile(file);
      const previous = pinned.get(file);
      if (previous !== undefined && previous !== current.fingerprint) throw new Error('persistent_binding_changed');
      pinned.set(file, current.fingerprint);
      return current;
    };
    const authorization = (candidate: LearningCandidate, operation: ProviderOperationOptions) => {
      checkBudget(operation);
      const configuration = readPinned(options.configurationFile);
      const config = validationConfigurationSchema.parse(JSON.parse(configuration.bytes.toString('utf8')));
      const matches = config.checkers.filter(entry => entry.scope === parsed.data.scope && entry.checkerId === parsed.data.checkerId);
      if (matches.length !== 1) throw new Error('checker_binding_unavailable');
      const entry = matches[0];
      const before = readPinned(entry.authorizationFile);
      const grant = readKnowledgeGrant(entry.authorizationFile);
      readKnowledgeAuthorization({ authorizationFile: entry.authorizationFile, policy: grant.policy });
      const after = readPinned(entry.authorizationFile);
      if (before.fingerprint !== after.fingerprint || grant.policy.scope !== candidate.proposal.applicability.project
        || entry.scope !== grant.policy.scope || candidate.proposal.targetRef !== entry.target.ref
        || !grant.policy.targets.some(target => target.ref === entry.target.ref && target.kinds.some(kind => kind === candidate.proposal.kind))) {
        throw new Error('knowledge_authorization_unavailable');
      }
      checkBudget(operation);
      return { entry, configurationDigest: configuration.fingerprint,
        authorizationDigest: digest([configuration.fingerprint, after.fingerprint, grant]) };
    };
    const evidenceSources = (candidate: LearningCandidate, entry: ValidationConfiguration['checkers'][number]) => {
      const stored = ledger.getEvidencePack(candidate.evidenceDigest);
      const request = ledger.getRequest(candidate.requestKey);
      if (!stored || !request) throw new Error('source_snapshot_unavailable');
      let resolved: EvidenceSourceInput[];
      const runId = request.request.sourceRunId;
      const identity = runId ? { scope: request.request.scope, runId, analyzerVersion: request.request.analyzerVersion } : undefined;
      const cursor = identity && ledger.getScanCursor(identity);
      if (identity && cursor) {
        const root = ledger.getScanSourceRoot(identity);
        if (!root || !ledger.getScanRequestKeys(identity).includes(request.key)) throw new Error('managed_source_unregistered');
        savedPath.parse(root);
        const audit = { id: 'audit-1', kind: 'audit' as const, path: new JsonlEventStore({ root }).pathFor(identity.runId),
          allowedRoot: root, runId: identity.runId };
        const bytes = readSnapshotFile(audit.path, root, 64 * 1024 * 1024);
        const expected = stored.sources.find(source => source.id === audit.id && source.kind === 'audit')?.sourceDigest;
        if (!expected || bytesDigest(bytes) !== expected) throw new Error('managed_audit_changed');
        const history: RunEvent[] = new TextDecoder('utf-8', { fatal: true }).decode(bytes).split('\n')
          .filter(line => line.trim()).map(line => JSON.parse(line));
        const verified = verifyRunEventHistory(identity.runId, history);
        if (!verified.valid || !verified.lastSequence || history[cursor.sequence - 1]?.integrity.hash !== cursor.head) throw new Error('managed_audit_invalid');
        successfulRunEvidenceFromEvents({ scope: identity.scope, runId: identity.runId,
          workItemId: request.request.workItemId ?? history[0].context.workItemId, evidence: [] }, history);
        const recorded = history.flatMap(event => event.data.kind === 'agent.session_recorded' ? [event.data] : []);
        const sessions = [...new Map(recorded.map(session => [session.sessionId, session])).values()]
          .sort((first, second) => first.sessionId < second.sessionId ? -1 : first.sessionId > second.sessionId ? 1 : 0);
        if (sessions.length > 63) throw new Error('managed_source_limit');
        const home = realpathSync(homedir());
        const roots = [join(home, '.afk', 'transcripts'), join(home, '.claude', 'projects'),
          join(home, '.codex', 'sessions'), join(home, '.codex', 'archived_sessions')];
        resolved = [audit, ...sessions.map((session, index) => {
          const path = savedPath.parse(session.transcriptPath);
          const allowedRoot = roots.find(root => {
            const location = relative(root, path);
            return location !== '' && !isAbsolute(location) && location !== '..' && !location.startsWith(`..${sep}`);
          });
          if (!allowedRoot) throw new Error('managed_session_not_allowed');
          return { id: `session-${index + 1}`, kind: 'session' as const, path, allowedRoot };
        })];
      } else {
        const manifest = entry.evidence?.find(evidence => evidence.digest === candidate.evidenceDigest);
        if (!manifest) throw new Error('source_manifest_unavailable');
        resolved = manifest.sources;
      }
      if (stored.sources.length !== resolved.length) throw new Error('source_manifest_mismatch');
      const sources = resolved.map(source => {
        const original = stored.sources.find(original => original.id === source.id);
        if (!original?.sourceDigest || original.kind !== source.kind || original.completeness !== 'complete'
          || (source.kind === 'audit' && request?.request.sourceRunId && source.runId !== request.request.sourceRunId)) {
          throw new Error('source_manifest_mismatch');
        }
        return { ...source, expectedDigest: original.sourceDigest };
      });
      return { stored, sources };
    };
    const reconcile: LearningValidationDependencies['reconcile'] = async (candidate, operation) => {
      const { entry } = authorization(candidate, operation);
      const { stored, sources } = evidenceSources(candidate, entry);
      const actual = await buildEvidencePack({ sources });
      checkBudget(operation);
      authorization(candidate, operation);
      return { current: actual.completeness === 'complete' && actual.digest === stored.digest, evidenceDigest: actual.digest };
    };
    const snapshot = async (entry: ValidationConfiguration['checkers'][number], operation: ProviderOperationOptions) => {
      checkBudget(operation);
      const path = join(entry.target.root, entry.target.path);
      const bytes = await readEvidenceSource(path, entry.target.root, DISTILLATION_LIMITS.evidenceBytes);
      checkBudget(operation);
      if (!bytes) throw new Error('target_snapshot_unavailable');
      const snapshotDigest = bytesDigest(bytes);
      return { target: { scope: entry.scope, ref: entry.target.ref, revision: `sha256:${snapshotDigest}`, snapshotDigest },
        snapshot: { path, content: new TextDecoder('utf-8', { fatal: true }).decode(bytes) } };
    };
    let bound: { provider: VerificationProvider; verify: VerificationProvider['verify']; doctor: NonNullable<VerificationProvider['doctor']>;
      capabilities: string; identity: z.infer<typeof checkerIdentitySchema>; semantic: VerificationProvider } | undefined;
    const assertProvider = () => {
      if (!bound || bound.provider.id !== bound.identity.providerId || bound.provider.verify !== bound.verify
        || bound.provider.doctor !== bound.doctor || canonicalLearningJson(bound.provider.capabilities) !== bound.capabilities) {
        throw new Error('checker_provider_changed');
      }
      return bound;
    };
    const dependencies: LearningValidationDependencies = {
      store: ledger,
      authorize: async (candidate, operation) => ({ allowed: true, authorizationDigest: authorization(candidate, operation).authorizationDigest }),
      reconcile,
      resolveChecker: async (candidate, checkerId, operation) => {
        const current = authorization(candidate, operation);
        const identity = checkerIdentitySchema.parse({ scope: current.entry.scope, checkerId,
          providerId: current.entry.providerId, version: current.entry.version });
        const observed = await snapshot(current.entry, operation);
        const provider = await options.resolveProvider({ ...identity, snapshot: observed.snapshot }, operation);
        checkBudget(operation);
        if (!provider || provider.id !== identity.providerId || provider.capabilities['test-execution'] !== true
          || typeof provider.verify !== 'function' || typeof provider.doctor !== 'function') return undefined;
        if (!bound) {
          const verify = provider.verify;
          const doctor = provider.doctor;
          const semantic: VerificationProvider = { id: provider.id, capabilities: { ...provider.capabilities },
            verify: async (request, operation) => {
              checkBudget(operation);
              assertProvider();
              const result = await verify.call(provider, request, operation);
              checkBudget(operation);
              return result;
            },
            doctor: async operation => {
              checkBudget(operation);
              assertProvider();
              const diagnostics = await doctor.call(provider, operation);
              checkBudget(operation);
              assertProvider();
              if (!Array.isArray(diagnostics) || diagnostics.length > 32) throw new Error('semantic_protocol_unavailable');
              const protocol = diagnostics.filter(diagnostic => diagnostic?.check === 'learning-validation-v1');
              if (protocol.length !== 1 || protocol[0].ok !== true || typeof protocol[0].detail !== 'string'
                || protocol[0].detail.length > 2048) throw new Error('semantic_protocol_unavailable');
              const declared = checkerIdentitySchema.parse(JSON.parse(protocol[0].detail));
              if (canonicalLearningJson(declared) !== canonicalLearningJson(identity)) throw new Error('semantic_identity_changed');
              return diagnostics;
            } };
          bound = { provider, verify, doctor, identity, capabilities: canonicalLearningJson(provider.capabilities), semantic };
        }
        if (assertProvider().provider !== provider || canonicalLearningJson(bound.identity) !== canonicalLearningJson(identity)) return undefined;
        await bound.semantic.doctor!(operation);
        const source = await reconcile(candidate, operation);
        if (!source.current || source.evidenceDigest !== candidate.evidenceDigest) return undefined;
        const final = await snapshot(current.entry, operation);
        if (canonicalLearningJson(observed) !== canonicalLearningJson(final)) return undefined;
        authorization(candidate, operation);
        return { id: checkerId, version: identity.version, mode: 'independent-assertions', provider: bound.semantic,
          configurationDigest: current.configurationDigest, target: observed.target };
      },
      readCommitSnapshot: (candidate, checkerId) => {
        checkBudget(options);
        const current = authorization(candidate, options);
        const selected = assertProvider();
        const identity = checkerIdentitySchema.parse({ scope: current.entry.scope, checkerId,
          providerId: current.entry.providerId, version: current.entry.version });
        if (canonicalLearningJson(identity) !== canonicalLearningJson(selected.identity)) throw new Error('checker_identity_changed');
        const { stored, sources } = evidenceSources(candidate, current.entry);
        const sourceCurrent = sources.every(source => bytesDigest(readSnapshotFile(source.path, source.allowedRoot, 64 * 1024 * 1024)) === source.expectedDigest);
        const snapshotDigest = bytesDigest(readSnapshotFile(join(current.entry.target.root, current.entry.target.path),
          current.entry.target.root, DISTILLATION_LIMITS.evidenceBytes));
        const checker: LearningValidationChecker = { id: checkerId, version: identity.version,
          configurationDigest: current.configurationDigest, mode: 'independent-assertions', provider: selected.semantic,
          target: { scope: current.entry.scope, ref: current.entry.target.ref, revision: `sha256:${snapshotDigest}`, snapshotDigest } };
        checkBudget(options);
        return { authorization: { allowed: true, authorizationDigest: current.authorizationDigest },
          source: { current: sourceCurrent, evidenceDigest: stored.digest }, checker };
      },
    };
    const remainingMs = Math.floor(deadline - performance.now());
    if (remainingMs < 1) return { status: 'blocked', code: 'timed_out' };
    const result = await validateLearningCandidate(parsed.data, dependencies, { ...options, timeoutMs: remainingMs });
    if (result.status === 'blocked' && (expired || performance.now() >= deadline)) return { status: 'blocked', code: 'timed_out' };
    return result;
  } catch {
    return { status: 'blocked', code: expired || performance.now() >= deadline ? 'timed_out'
      : options.signal?.aborted ? 'cancelled' : 'storage_failed' };
  } finally { store?.close(); }
}
