import { createHash } from 'node:crypto';
import { closeSync, constants, existsSync, fstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { performance } from 'node:perf_hooks';
import type { RunEvent } from '@afk/core';
import { z } from 'zod';
import { JsonlEventStore, verifyRunEventHistory } from '../../infrastructure/observability/jsonl-event-store.js';
import { checkAbort } from '../../infrastructure/providers/dependencies.js';
import { isNativeRepositoryWorkspaceLease } from '../../infrastructure/providers/repositories.js';
import { isNativeVerificationObservation } from '../../infrastructure/verification/command.js';
import { executeNativeFrozenVerification, isNativeFrozenVerificationObservation } from '../../infrastructure/verification/frozen-command.js';
import { captureFrozenInput } from '../../infrastructure/sandbox/container/frozen-input.js';
import type { FrozenExecutionOwnership } from '../../infrastructure/sandbox/container/frozen-execution.js';
import type { ProviderOperationOptions, RepositoryProvider, VerificationProvider } from '../../plugin-sdk/capabilities.js';
import { CandidateStore, type LearningCandidate } from './candidate-store.js';
import { DISTILLATION_LIMITS, learningScopeSchema } from './contracts.js';
import { buildEvidencePack, managedTranscriptRoots, readEvidenceSource, type EvidenceSourceInput } from './evidence.js';
import { readKnowledgeAuthorization, readKnowledgeGrant } from './knowledge.js';
import { canonicalLearningJson, learningIdentitySchema } from './requests.js';
import { failedRunEvidenceFromEvents, successfulRunEvidenceFromEvents } from './run-evidence.js';
import { validateLearningCandidate, type LearningValidationChecker, type LearningValidationDependencies, type LearningValidationResult } from './validation.js';
import { factExecutionGrantSchema, factWorkspaceSchema, selectKnowledgeValidationChecker, validationConfigurationSchema,
  type KnowledgeValidationCheckerConfiguration } from './validation-configuration.js';
import { readValidationPrivateFile as readPrivateFile, readValidationSnapshotFile as readSnapshotFile } from './validation-files.js';
import { parseLearningValidationInput } from './validation-input.js';
import type { ProposalRepositorySelectionBinding } from './proposal-validation-runtime.js';

export { validationConfigurationSchema } from './validation-configuration.js';
export type { ValidationConfiguration } from './validation-configuration.js';

const savedPath = z.string().min(1).max(4096).refine(value => isAbsolute(value) && resolve(value) === value && !/[\0\r\n]/.test(value));
const checkerIdentitySchema = z.object({ scope: learningScopeSchema, checkerId: learningIdentitySchema,
  providerId: learningIdentitySchema, version: learningIdentitySchema }).strict();

export type ValidationProviderBinding = z.infer<typeof checkerIdentitySchema> & { snapshot: { path: string; content: string } };
const factLeaseSnapshotSchema = z.object({ workspace: factWorkspaceSchema, leaseId: learningIdentitySchema,
  state: z.enum(['active', 'closed']) }).strict();
export interface FactValidationWorkspaceLease {
  readCommitSnapshot(): z.infer<typeof factLeaseSnapshotSchema>;
  cleanup(): Promise<{ closed: true }>;
}
export interface ValidationRuntimeOptions extends ProviderOperationOptions {
  file: string;
  homeDir?: string;
  configurationFile: string;
  resolveProvider(binding: ValidationProviderBinding, options: ProviderOperationOptions): Promise<VerificationProvider | undefined>;
  resolveRepositoryProvider?(providerId: string, options: ProviderOperationOptions): Promise<RepositoryProvider | undefined>;
  fact?: {
    resolveWorkspace(binding: z.infer<typeof factWorkspaceSchema>, options: ProviderOperationOptions): Promise<FactValidationWorkspaceLease | undefined>;
  };
  proposal?: {
    resolveRepository(binding: ProposalRepositorySelectionBinding, options: ProviderOperationOptions): Promise<RepositoryProvider | undefined>;
  };
  frozen?: { onOwnership?(ownership: FrozenExecutionOwnership): void | Promise<void> };
  timeoutMs?: number;
}

const bytesDigest = (input: Buffer) => createHash('sha256').update(input).digest('hex');
const digest = (input: unknown) => createHash('sha256').update(canonicalLearningJson(input)).digest('hex');

function checkerFileDigest(file: string): string {
  if (realpathSync(file) !== file) throw new Error('checker_file_unsafe');
  const descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(descriptor, { bigint: true });
    if (!before.isFile() || before.size > 256n * 1024n * 1024n || (before.mode & 0o022n) !== 0n) throw new Error('checker_file_unsafe');
    const hash = createHash('sha256');
    const buffer = Buffer.alloc(64 * 1024);
    let total = 0n;
    let count: number;
    while ((count = readSync(descriptor, buffer, 0, buffer.length, null)) > 0) {
      total += BigInt(count);
      if (total > before.size) throw new Error('checker_file_changed');
      hash.update(buffer.subarray(0, count));
    }
    const after = fstatSync(descriptor, { bigint: true });
    const named = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const current = fstatSync(named, { bigint: true });
      const identity = (stats: typeof before) => [stats.dev, stats.ino, stats.size, stats.mode, stats.uid, stats.nlink, stats.mtimeNs, stats.ctimeNs].join(':');
      if (total !== before.size || identity(before) !== identity(after) || identity(before) !== identity(current)
        || realpathSync(file) !== file) throw new Error('checker_file_changed');
    } finally { closeSync(named); }
    return hash.digest('hex');
  } finally { closeSync(descriptor); }
}

export async function validateConfiguredLearningCandidate(input: unknown, options: ValidationRuntimeOptions): Promise<LearningValidationResult> {
  const began = performance.now();
  const parsed = parseLearningValidationInput(input);
  const timeout = z.number().int().positive().max(DISTILLATION_LIMITS.timeoutMs)
    .safeParse(options.timeoutMs === undefined ? DISTILLATION_LIMITS.timeoutMs : options.timeoutMs);
  if (!parsed?.success || !timeout.success) return { status: 'blocked', code: 'invalid_input' };
  const deadline = began + timeout.data;
  let expired = false;
  const checkBudget = (operation: ProviderOperationOptions = {}) => {
    if (expired || performance.now() >= deadline) { expired = true; throw new Error('validation_deadline_exceeded'); }
    checkAbort(operation);
  };
  if (options.signal?.aborted) return { status: 'blocked', code: 'cancelled' };
  let store: CandidateStore | undefined;
  let finished = false;
  let runningVerification: Promise<unknown> | undefined;
  let repositoryScope: { release(): void; done: Promise<unknown>; entered: boolean } | undefined;
  let factLease: { lease: FactValidationWorkspaceLease; read: FactValidationWorkspaceLease['readCommitSnapshot'];
    cleanup: FactValidationWorkspaceLease['cleanup']; snapshot?: z.infer<typeof factLeaseSnapshotSchema>;
    closed: boolean; closing?: Promise<{ closed: true }> } | undefined;
  const readFactLease = () => {
    if (!factLease?.snapshot || factLease.lease.readCommitSnapshot !== factLease.read || factLease.lease.cleanup !== factLease.cleanup) throw new Error('workspace_lease_unavailable');
    const current = factLeaseSnapshotSchema.parse(factLease.read.call(factLease.lease));
    const expected = { ...factLease.snapshot, state: factLease.closed ? 'closed' : 'active' };
    if (canonicalLearningJson(current) !== canonicalLearningJson(expected) || realpathSync(current.workspace.cwd) !== current.workspace.cwd) throw new Error('workspace_lease_changed');
    return current;
  };
  const closeFactLease = async () => {
    if (!factLease) throw new Error('workspace_lease_unavailable');
    const selected = factLease;
    selected.closing ??= (async () => {
      await runningVerification?.catch(() => undefined);
      const proof = z.object({ closed: z.literal(true) }).strict().parse(await selected.cleanup.call(selected.lease));
      selected.closed = true;
      readFactLease();
      return proof;
    })();
    return selected.closing;
  };
  const acquireRepositoryWorkspace = async (binding: z.infer<typeof factWorkspaceSchema>, operation: ProviderOperationOptions) => {
    if (binding.kind !== 'repository') return undefined;
    const provider = await options.resolveRepositoryProvider!(binding.providerId, operation);
    checkBudget(operation);
    if (!provider || provider.id !== binding.providerId || !provider.withWorkspaceLease) return undefined;
    const withLease = provider.withWorkspaceLease;
    let release!: () => void;
    const completion = new Promise<void>(complete => { release = complete; });
    let accept!: (lease: FactValidationWorkspaceLease) => void;
    let reject!: (error: unknown) => void;
    const ready = new Promise<FactValidationWorkspaceLease>((resolveLease, rejectLease) => { accept = resolveLease; reject = rejectLease; });
    const scope = { release, entered: false, done: Promise.resolve() as Promise<unknown> };
    repositoryScope = scope;
    scope.done = Promise.resolve().then(() => withLease.call(provider,
      { workspaceId: binding.id, path: binding.cwd, expectedCommit: binding.revision }, async native => {
        scope.entered = true;
        checkBudget(operation);
        if (finished || !isNativeRepositoryWorkspaceLease(native)) throw new Error('native_workspace_lease_unavailable');
        const read = native.readSnapshot;
        let state: 'active' | 'closed' = 'active';
        const lease: FactValidationWorkspaceLease = {
          readCommitSnapshot: () => {
            if (provider.withWorkspaceLease !== withLease || native.readSnapshot !== read) throw new Error('workspace_provider_changed');
            const snapshot = read.call(native);
            return { workspace: { kind: 'repository', providerId: provider.id, id: native.workspace.id,
              cwd: native.workspace.path!, revision: snapshot.commit }, leaseId: native.leaseId, state };
          },
          cleanup: async () => { state = 'closed'; return { closed: true }; },
        };
        if (canonicalLearningJson(lease.readCommitSnapshot().workspace) !== canonicalLearningJson(binding)) throw new Error('workspace_binding_changed');
        accept(lease);
        await completion;
      }, operation));
    void scope.done.then(() => reject(new Error('workspace_scope_closed')), reject);
    return ready;
  };
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
      const entry = selectKnowledgeValidationChecker(config, parsed.data.scope, parsed.data.checkerId);
      if (!entry) throw new Error('checker_binding_unavailable');
      let executionAuthorizationDigest: string | undefined;
      if ('mode' in entry && entry.mode === 'fact-command') {
        if (candidate.proposal.kind !== 'fact') throw new Error('fact_checker_kind_mismatch');
        const execution = readPinned(entry.executionAuthorizationFile);
        const authority = factExecutionGrantSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(execution.bytes)));
        if (authority.revoked || authority.scope !== entry.scope || authority.checkerId !== entry.checkerId
          || authority.checkerVersion !== entry.version || authority.checkerDigest !== digest(entry)
          || canonicalLearningJson(authority.execution) !== canonicalLearningJson(entry.execution)) throw new Error('execution_authorization_unavailable');
        for (const file of entry.execution.checkerFiles) {
          if (checkerFileDigest(file.path) !== file.digest) throw new Error('checker_file_changed');
          checkBudget(operation);
        }
        if (entry.execution.frozen && captureFrozenInput(entry.execution.frozen.checkerRoot).digest !== entry.execution.frozen.checkerDigest) {
          throw new Error('checker_closure_changed');
        }
        checkBudget(operation);
        executionAuthorizationDigest = execution.fingerprint;
      }
      const before = readPinned(entry.authorizationFile);
      const grant = readKnowledgeGrant(entry.authorizationFile);
      readKnowledgeAuthorization({ authorizationFile: entry.authorizationFile, policy: grant.policy });
      const after = readPinned(entry.authorizationFile);
      if (before.fingerprint !== after.fingerprint || grant.policy.scope !== candidate.proposal.applicability.project
        || entry.scope !== grant.policy.scope || candidate.proposal.targetRef !== entry.target.ref
        || !grant.policy.targets.some(target => target.ref === entry.target.ref && (candidate.proposal.kind === 'lesson'
          ? entry.allowLessonValidation === true : target.kinds.some(kind => kind === candidate.proposal.kind)))) {
        throw new Error('knowledge_authorization_unavailable');
      }
      checkBudget(operation);
      return { entry, configurationDigest: configuration.fingerprint,
        authorizationDigest: digest([configuration.fingerprint, after.fingerprint, grant,
          ...(executionAuthorizationDigest ? [executionAuthorizationDigest] : [])]) };
    };
    const evidenceSources = (candidate: LearningCandidate, entry: Pick<KnowledgeValidationCheckerConfiguration, 'evidence' | 'qa'>) => {
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
        const input = { scope: identity.scope, runId: identity.runId,
          workItemId: request.request.workItemId ?? history[0].context.workItemId, evidence: [] };
        if (candidate.proposal.kind === 'lesson' && entry.qa?.repair) {
          const pin = entry.qa.repair.failure;
          if (pin.runId !== identity.runId || pin.root !== root || pin.auditDigest !== expected) throw new Error('managed_failure_mismatch');
          failedRunEvidenceFromEvents(input, history);
        } else successfulRunEvidenceFromEvents(input, history);
        const recorded = history.flatMap(event => event.data.kind === 'agent.session_recorded' ? [event.data] : []);
        const sessions = [...new Map(recorded.map(session => [session.sessionId, session])).values()]
          .sort((first, second) => first.sessionId < second.sessionId ? -1 : first.sessionId > second.sessionId ? 1 : 0);
        if (sessions.length > 63) throw new Error('managed_source_limit');
        const home = realpathSync(options.homeDir ?? homedir());
        const roots = managedTranscriptRoots(home);
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
        return { ...source, ...(cursor && original.range ? { range: original.range } : {}), expectedDigest: original.sourceDigest };
      });
      return { stored, sources };
    };
    const candidate = ledger.getCandidate(parsed.data.candidateId);
    if (candidate?.proposal.kind === 'tool' || candidate?.proposal.kind === 'skill') {
      if (candidate.proposal.applicability.project !== parsed.data.scope) return { status: 'blocked', code: 'scope_mismatch' };
      if (candidate.version !== parsed.data.expectedVersion || candidate.state !== 'candidate') return { status: 'blocked', code: 'stale_candidate' };
      const configuration = readPinned(options.configurationFile);
      const config = validationConfigurationSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(configuration.bytes)));
      const entry = config.version === 2 ? config.checkers.find(entry => entry.mode === 'repository-asset'
        && entry.scope === parsed.data.scope && entry.checkerId === parsed.data.checkerId) : undefined;
      if (entry?.mode !== 'repository-asset' || entry.kind !== candidate.proposal.kind) return { status: 'blocked', code: 'unsupported_kind' };
      const controller = new AbortController();
      let cancel: () => void = () => undefined;
      const cancellation = new Promise<never>((_resolve, reject) => {
        cancel = () => { controller.abort(options.signal?.reason); reject(new Error('proposal_validation_cancelled')); };
      });
      options.signal?.addEventListener('abort', cancel, { once: true });
      const timer = setTimeout(() => { expired = true; cancel(); }, Math.max(1, Math.ceil(deadline - performance.now())));
      try {
        checkBudget(options);
        const assembled = await Promise.race([import('./proposal-validation-runtime.js').then(({ createConfiguredProposalDependencies }) => {
          checkBudget({ signal: controller.signal });
          return createConfiguredProposalDependencies(candidate, { ...options, signal: controller.signal, store: ledger,
            checkerId: parsed.data.checkerId, checkBudget, remainingMs: () => Math.floor(deadline - performance.now()),
            evidenceSources, resolveRepository: options.proposal?.resolveRepository });
        }), cancellation]);
        checkBudget(options);
        if (assembled.status !== 'ready') return assembled;
        const { validateProposalCandidate } = await Promise.race([import('./proposal-validation.js'), cancellation]);
        checkBudget({ signal: controller.signal });
        const result = await validateProposalCandidate(parsed.data, assembled.dependencies, { ...options, signal: controller.signal,
          timeoutMs: Math.max(1, Math.floor(deadline - performance.now())) });
        if (result.status === 'blocked' && result.code !== 'storage_failed' && (expired || performance.now() >= deadline)) {
          return { status: 'blocked', code: 'timed_out' };
        }
        return result;
      } finally {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', cancel);
      }
    }
    const reconcile: LearningValidationDependencies['reconcile'] = async (candidate, operation) => {
      const { entry } = authorization(candidate, operation);
      const { stored, sources } = evidenceSources(candidate, entry);
      const actual = await buildEvidencePack({ sources });
      checkBudget(operation);
      authorization(candidate, operation);
      return { current: actual.completeness === 'complete' && actual.digest === stored.digest, evidenceDigest: actual.digest };
    };
    const snapshot = async (entry: KnowledgeValidationCheckerConfiguration, operation: ProviderOperationOptions) => {
      checkBudget(operation);
      const path = join(entry.target.root, entry.target.path);
      const bytes = await readEvidenceSource(path, entry.target.root, DISTILLATION_LIMITS.evidenceBytes);
      checkBudget(operation);
      if (!bytes) throw new Error('target_snapshot_unavailable');
      const snapshotDigest = bytesDigest(bytes);
      return { target: { scope: entry.scope, ref: entry.target.ref, revision: `sha256:${snapshotDigest}`, snapshotDigest },
        snapshot: { path, content: new TextDecoder('utf-8', { fatal: true }).decode(bytes) } };
    };
    let bound: { provider: VerificationProvider; verify: VerificationProvider['verify']; doctor: VerificationProvider['doctor'];
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
      completeExecution: async operation => { checkBudget(operation); const proof = await closeFactLease(); checkBudget(operation); return proof; },
      authorize: async (candidate, operation) => ({ allowed: true, authorizationDigest: authorization(candidate, operation).authorizationDigest }),
      reconcile,
      resolveChecker: async (candidate, checkerId, operation) => {
        const current = authorization(candidate, operation);
        const identity = checkerIdentitySchema.parse({ scope: current.entry.scope, checkerId,
          providerId: current.entry.providerId, version: current.entry.version });
        const observed = await snapshot(current.entry, operation);
        const command = 'mode' in current.entry && current.entry.mode === 'fact-command' ? current.entry : undefined;
        if (command) {
          if (command.execution.frozen && !options.frozen) return undefined;
          if (!options.fact && !options.resolveRepositoryProvider) return undefined;
          if (!factLease) {
            const lease = options.fact
              ? await options.fact.resolveWorkspace(structuredClone(command.execution.workspace), operation)
              : await acquireRepositoryWorkspace(structuredClone(command.execution.workspace), operation);
            if (!lease || typeof lease.readCommitSnapshot !== 'function' || typeof lease.cleanup !== 'function') return undefined;
            factLease = { lease, read: lease.readCommitSnapshot, cleanup: lease.cleanup, closed: false };
            if (finished || operation.signal?.aborted || performance.now() >= deadline) {
              await closeFactLease();
              return undefined;
            }
            const initial = factLeaseSnapshotSchema.parse(lease.readCommitSnapshot());
            factLease.snapshot = initial;
            if (initial.state !== 'active' || canonicalLearningJson(initial.workspace) !== canonicalLearningJson(command.execution.workspace)) return undefined;
          }
          readFactLease();
          checkBudget(operation);
        }
        const frozen = command?.execution.frozen;
        const provider: VerificationProvider | undefined = frozen ? bound?.provider ?? {
          id: identity.providerId, capabilities: { 'test-execution': true, 'custom-script': false, 'static-analysis': false },
          verify: async (request, operation) => {
            if (!request.input || !request.executionId || !command || !options.frozen
              || canonicalLearningJson(request.command) !== canonicalLearningJson(command.execution.command)
              || request.target !== '/workspace') throw new Error('frozen_request_unavailable');
            const assertCurrent = () => {
              checkBudget(operation);
              const selected = ledger.getCandidate(candidate.id);
              if (!selected || selected.state !== 'candidate' || selected.version !== candidate.version
                || selected.digest !== candidate.digest || selected.evidenceDigest !== candidate.evidenceDigest
                || ledger.getRequest(candidate.requestKey)?.blockedReason) throw new Error('stale_candidate');
              const authority = authorization(selected, operation ?? {});
              if (authority.configurationDigest !== current.configurationDigest || authority.authorizationDigest !== current.authorizationDigest
                || canonicalLearningJson(authority.entry) !== canonicalLearningJson(command)) throw new Error('execution_authorization_changed');
              if (factLease?.closed || readFactLease().state !== 'active') throw new Error('workspace_lease_closed');
              assertProvider();
              const { stored, sources } = evidenceSources(selected, authority.entry);
              if (stored.digest !== selected.evidenceDigest || sources.some(source => {
                checkBudget(operation);
                return bytesDigest(readSnapshotFile(source.path, source.allowedRoot, 64 * 1024 * 1024)) !== source.expectedDigest;
              })) throw new Error('source_changed');
              if (bytesDigest(readSnapshotFile(observed.snapshot.path, command.target.root, DISTILLATION_LIMITS.evidenceBytes))
                !== observed.target.snapshotDigest) throw new Error('target_snapshot_changed');
              checkBudget(operation);
            };
            const began = performance.now();
            let registered: ReturnType<CandidateStore['recordFactOwnership']> | undefined;
            const execution = await executeNativeFrozenVerification({ version: 1, ...frozen,
              executionId: request.executionId, command: [...command.execution.command], input: request.input,
              target: { content: observed.snapshot.content, digest: observed.target.snapshotDigest },
              timeoutMs: Math.min(request.timeoutMs ?? command.execution.timeoutMs, command.execution.timeoutMs) },
            { ...operation, onOwnership: async ownership => {
              if (ownership.baseImageId !== frozen.baseImageId) throw new Error('frozen_image_changed');
              registered = ledger.recordFactOwnership({ ownership,
                binding: { scope: current.entry.scope, candidateId: candidate.id, candidateVersion: candidate.version,
                  evidenceDigest: candidate.evidenceDigest },
                check: { executionId: request.executionId, checkerId, checkerVersion: identity.version,
                  configurationDigest: current.configurationDigest, authorizationDigest: current.authorizationDigest,
                  checkerDigest: frozen.checkerDigest, requestDigest: bytesDigest(Buffer.from(request.input!, 'utf8')),
                  targetDigest: observed.target.snapshotDigest, workspace: command.execution.workspace, leaseId: readFactLease().leaseId },
              }, assertCurrent);
              await options.frozen?.onOwnership?.(ownership);
              assertCurrent();
            } });
            const proof = execution.frozen;
            const persisted = proof && ledger.getFactOwnership(proof.operationId);
            if (!registered || !proof || !persisted || canonicalLearningJson(persisted) !== canonicalLearningJson(registered)
              || registered.ownership.operationId !== proof.operationId || registered.ownership.baseImageId !== proof.baseImageId
              || registered.ownership.inputDigest !== proof.inputDigest || registered.ownership.contextDigest !== proof.contextDigest
              || registered.check.executionId !== execution.executionId || registered.check.requestDigest !== execution.inputDigest
              || registered.check.checkerDigest !== proof.checkerDigest || registered.check.targetDigest !== proof.targetDigest) {
              throw new Error('frozen_ownership_mismatch');
            }
            return { passed: execution.exitCode === 0, durationMs: performance.now() - began, execution };
          },
        } : await options.resolveProvider({ ...identity, snapshot: observed.snapshot }, operation);
        checkBudget(operation);
        if (!provider || provider.id !== identity.providerId || provider.capabilities['test-execution'] !== true
          || typeof provider.verify !== 'function' || (!command && typeof provider.doctor !== 'function')) return undefined;
        if (!bound) {
          const verify = provider.verify;
          const doctor = provider.doctor;
          const semantic: VerificationProvider = { id: provider.id, capabilities: { ...provider.capabilities },
            verify: async (request, operation) => {
              checkBudget(operation);
              assertProvider();
              if (command) {
                if (factLease?.closed) throw new Error('workspace_lease_closed');
                readFactLease();
                authorization(candidate, operation ?? {});
              }
              const pending = Promise.resolve(verify.call(provider, command ? { ...request,
                timeoutMs: Math.min(request.timeoutMs ?? command.execution.timeoutMs, command.execution.timeoutMs) } : request, operation));
              if (command) runningVerification = pending;
              try {
                const result = await pending;
                checkBudget(operation);
                const native = command?.execution.frozen ? isNativeFrozenVerificationObservation : isNativeVerificationObservation;
                return command && !native(result.execution)
                  ? { ...result, execution: undefined } : result;
              } finally { if (runningVerification === pending) runningVerification = undefined; }
            },
            doctor: async operation => {
              checkBudget(operation);
              assertProvider();
              if (command) {
                readFactLease();
                return [{ check: 'learning-validation-v1', ok: true, detail: canonicalLearningJson(identity) }];
              }
              const diagnostics = await doctor!.call(provider, operation);
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
          configurationDigest: current.configurationDigest, target: observed.target,
          ...(command ? { execution: { protocol: 'learning-fact-command-v1', command: command.execution.command,
            cwd: command.execution.frozen ? '/workspace' : command.execution.workspace.cwd,
            ...(command.execution.frozen ? { frozen: command.execution.frozen } : {}), workspaceDigest: digest(command.execution.workspace),
            workspaceRevision: command.execution.workspace.revision, leaseId: readFactLease().leaseId } } : {}),
          ...(current.entry.qa ? { qa: current.entry.qa } : {}) };
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
        const command = 'mode' in current.entry && current.entry.mode === 'fact-command' ? current.entry : undefined;
        if (command && !factLease?.closed) throw new Error('workspace_cleanup_required');
        const checker: LearningValidationChecker = { id: checkerId, version: identity.version,
          configurationDigest: current.configurationDigest, mode: 'independent-assertions', provider: selected.semantic,
          ...(current.entry.qa ? { qa: current.entry.qa } : {}),
          ...(command ? { execution: { protocol: 'learning-fact-command-v1', command: command.execution.command,
            cwd: command.execution.frozen ? '/workspace' : command.execution.workspace.cwd,
            ...(command.execution.frozen ? { frozen: command.execution.frozen } : {}), workspaceDigest: digest(command.execution.workspace),
            workspaceRevision: command.execution.workspace.revision, leaseId: readFactLease().leaseId } } : {}),
          target: { scope: current.entry.scope, ref: current.entry.target.ref, revision: `sha256:${snapshotDigest}`, snapshotDigest } };
        const qa = candidate.proposal.kind === 'lesson' ? current.entry.qa : undefined;
        const qaAuditDigest = qa ? bytesDigest(readSnapshotFile(new JsonlEventStore({ root: qa.root }).pathFor(qa.runId),
          qa.root, DISTILLATION_LIMITS.evidenceBytes)) : undefined;
        const repairDigest = (pin: NonNullable<NonNullable<typeof qa>['repair']>['failure']) => bytesDigest(readSnapshotFile(
          new JsonlEventStore({ root: pin.root }).pathFor(pin.runId), pin.root, DISTILLATION_LIMITS.evidenceBytes));
        const repairAuditDigests = qa?.repair ? { failure: repairDigest(qa.repair.failure), fix: repairDigest(qa.repair.fix) } : undefined;
        checkBudget(options);
        return { authorization: { allowed: true, authorizationDigest: current.authorizationDigest },
          source: { current: sourceCurrent, evidenceDigest: stored.digest }, checker, qaAuditDigest, repairAuditDigests };
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
  } finally {
    finished = true;
    try {
      if (factLease && !factLease.closed) {
        let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
        let abortCleanup: () => void = () => undefined;
        const budget = new Promise<never>((_resolve, reject) => {
          abortCleanup = () => reject(new Error('cleanup_cancelled'));
          options.signal?.addEventListener('abort', abortCleanup, { once: true });
          cleanupTimer = setTimeout(() => reject(new Error('cleanup_timed_out')), Math.max(1, Math.ceil(deadline - performance.now())));
          if (options.signal?.aborted) abortCleanup();
        });
        try { await Promise.race([closeFactLease(), budget]); }
        catch {
          return { status: 'blocked', code: options.signal?.aborted ? 'cancelled'
            : performance.now() >= deadline ? 'timed_out' : 'cleanup_failed' };
        } finally {
          clearTimeout(cleanupTimer);
          options.signal?.removeEventListener('abort', abortCleanup);
          store?.close();
        }
      } else store?.close();
    } finally {
      const scope = repositoryScope;
      if (scope) {
        const release = () => { scope.release(); return scope.done; };
        if (!factLease || factLease.closed) {
          scope.release();
          if (scope.entered) {
            try { await scope.done; }
            catch {
              if (factLease) return { status: 'blocked', code: options.signal?.aborted ? 'cancelled'
                : performance.now() >= deadline ? 'timed_out' : 'cleanup_failed' };
            }
          }
        } else {
          void factLease.closing?.then(release, () => { if (factLease?.closed) return release(); }).catch(() => undefined);
        }
      }
    }
  }
}
