import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, realpathSync } from 'node:fs';
import { z } from 'zod';
import type { ProviderOperationOptions, RepositoryProvider } from '../../plugin-sdk/capabilities.js';
import { DockerContainerProvider } from '../../infrastructure/sandbox/container/docker.js';
import { executeFrozenContainer } from '../../infrastructure/sandbox/container/frozen-execution.js';
import { captureFrozenScratchHelper, type CapturedFrozenScratchHelper } from '../../infrastructure/sandbox/container/frozen-input.js';
import type { CandidateStore, LearningCandidate } from './candidate-store.js';
import { buildEvidencePack, type EvidencePack, type EvidenceSourceInput } from './evidence.js';
import { readProposalCatalog, type ProposalCatalog } from './proposal-catalog.js';
import { prepareAssetProposal } from './proposals.js';
import { prepareProposalExperiment, proposalSemanticConfigurationSchema } from './proposal-semantics.js';
import type { ProposalRuntimeHarness } from './proposal-runtime.js';
import type { ProposalValidationChecker, ProposalValidationDependencies } from './proposal-validation.js';
import { canonicalLearningJson } from './requests.js';
import { proposalExecutionGrantSchema, validationConfigurationSchema, type ValidationConfiguration } from './validation-configuration.js';
import { readValidationPrivateFile, readValidationSnapshotFile } from './validation-files.js';
import type { LearningValidationResult } from './validation.js';

export const PROPOSAL_VALIDATION_RUNTIME_REVISION = 'proposal-validation-runtime-v4';
export const PROPOSAL_VALIDATION_ADAPTER_REVISION = 'v1';
type AssetChecker = Extract<Extract<ValidationConfiguration, { version: 2 }>['checkers'][number], { mode: 'repository-asset' }>;
type Blocked = Extract<LearningValidationResult, { status: 'blocked' }>;
const digest = (value: unknown) => createHash('sha256').update(canonicalLearningJson(value)).digest('hex');
const same = (first: unknown, second: unknown) => canonicalLearningJson(first) === canonicalLearningJson(second);
const snapshotSchema = z.object({ commit: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
  branch: z.string().max(4096), dirty: z.boolean() }).strict();

export interface ProposalRepositorySelectionBinding {
  scope: string;
  checkerId: string;
  providerId: string;
  configurationDigest: string;
  authorizationDigest: string;
}

export interface ProposalValidationRuntimeOptions extends ProviderOperationOptions {
  store: CandidateStore;
  checkerId: string;
  configurationFile: string;
  checkBudget(options: ProviderOperationOptions): void;
  remainingMs(): number;
  evidenceSources(candidate: LearningCandidate, entry: Pick<AssetChecker, 'evidence'>): {
    stored: EvidencePack;
    sources: (EvidenceSourceInput & { expectedDigest: string })[];
  };
  resolveRepository?(binding: ProposalRepositorySelectionBinding, options: ProviderOperationOptions): Promise<RepositoryProvider | undefined>;
}

export async function createConfiguredProposalDependencies(candidate: LearningCandidate, options: ProposalValidationRuntimeOptions):
Promise<{ status: 'ready'; dependencies: ProposalValidationDependencies } | Blocked> {
  let failureCode: Blocked['code'] = 'unauthorized';
  const pins = new Map<string, string>();
  let catalog: ProposalCatalog | undefined;
  let scratchHelper: CapturedFrozenScratchHelper | undefined;
  const readPinned = (file: string) => {
    const current = readValidationPrivateFile(file);
    if (pins.has(file) && pins.get(file) !== current.identityFingerprint) throw new Error('proposal_configuration_changed');
    pins.set(file, current.identityFingerprint);
    return current;
  };
  const readHelper = (configuration: NonNullable<AssetChecker['sandbox']['scratchHelper']>) => {
    const identity = () => {
      const metadata = lstatSync(configuration.path);
      return digest([configuration.path, metadata.dev, metadata.ino, metadata.size, metadata.mode,
        metadata.uid, metadata.nlink, metadata.mtimeMs, metadata.ctimeMs]);
    };
    const before = identity();
    const captured = captureFrozenScratchHelper(configuration.path, configuration.digest);
    const after = identity();
    const key = `scratch-helper:${configuration.path}`;
    if (before !== after || (pins.has(key) && pins.get(key) !== after)
      || (scratchHelper !== undefined && !same(captured, scratchHelper))) throw new Error('proposal_helper_changed');
    pins.set(key, after);
    scratchHelper ??= captured;
    return after;
  };
  const authorization = (operation: ProviderOperationOptions) => {
    options.checkBudget(operation);
    const storedCandidate = options.store.getCandidate(candidate.id);
    const source = options.store.getRequest(candidate.requestKey);
    const blocked: Blocked['code'] | undefined = !storedCandidate ? 'candidate_unavailable'
      : !same(storedCandidate, candidate) || storedCandidate.state !== 'candidate' ? 'stale_candidate'
        : !source || source.blockedReason || source.request.scope !== candidate.proposal.applicability.project
          || source.request.evidenceDigest !== candidate.evidenceDigest ? 'source_unavailable' : undefined;
    if (blocked) { failureCode = blocked; throw new Error(blocked); }
    const configuration = readPinned(options.configurationFile);
    const config = validationConfigurationSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(configuration.bytes)));
    const entry = config.version === 2 ? config.checkers.find(entry => entry.mode === 'repository-asset'
      && entry.scope === candidate.proposal.applicability.project && entry.checkerId === options.checkerId) : undefined;
    if (entry?.mode !== 'repository-asset' || entry.kind !== candidate.proposal.kind) throw new Error('proposal_checker_unavailable');
    const authorized = readPinned(entry.executionAuthorizationFile);
    const grant = proposalExecutionGrantSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(authorized.bytes)));
    if (grant.revoked || grant.scope !== entry.scope || grant.checkerId !== entry.checkerId || grant.checkerVersion !== entry.version
      || grant.candidateId !== candidate.id || grant.candidateVersion !== candidate.version
      || grant.candidateDigest !== candidate.digest || grant.evidenceDigest !== candidate.evidenceDigest
      || grant.checkerDigest !== digest(entry) || grant.kind !== entry.kind || !same(grant.repository, entry.repository)
      || !same(grant.asset, entry.asset) || grant.inventoryDigest !== entry.inventory.digest || !same(grant.sandbox, entry.sandbox)
      || grant.adapter.id !== entry.semantic.adapter || grant.adapter.revision !== entry.semantic.revision
      || grant.adapter.hostRuntimeRevision !== PROPOSAL_VALIDATION_RUNTIME_REVISION
      || entry.semantic.revision !== PROPOSAL_VALIDATION_ADAPTER_REVISION || entry.version !== PROPOSAL_VALIDATION_ADAPTER_REVISION) {
      throw new Error('proposal_execution_not_authorized');
    }
    const helperIdentity = entry.sandbox.scratchHelper === undefined ? undefined : readHelper(entry.sandbox.scratchHelper);
    catalog?.assertCurrent();
    options.checkBudget(operation);
    return { entry, grant, configurationDigest: configuration.fingerprint,
      authorizationDigest: digest([configuration.identityFingerprint, authorized.identityFingerprint, catalog?.fingerprint ?? null,
        PROPOSAL_VALIDATION_RUNTIME_REVISION, ...(helperIdentity === undefined ? [] : [helperIdentity])]) };
  };
  const reconcile = async (operation: ProviderOperationOptions) => {
    const { entry } = authorization(operation);
    const { stored, sources } = options.evidenceSources(candidate, entry);
    const actual = await buildEvidencePack({ sources });
    authorization(operation);
    return { current: actual.completeness === 'complete' && actual.digest === stored.digest, evidenceDigest: actual.digest };
  };
  try {
    const initial = authorization(options);
    failureCode = 'source_unavailable';
    catalog = readProposalCatalog({ scope: initial.entry.scope, repositoryRoot: initial.entry.repository.root,
      expectedCommit: initial.entry.repository.expectedCommit, file: initial.entry.inventory.file, digest: initial.entry.inventory.digest });
    if (!(await reconcile(options)).current) return { status: 'blocked', code: 'source_unavailable' };
    failureCode = 'verification_failed';
    const prepared = prepareAssetProposal(candidate.proposal, catalog.inventory);
    if (prepared.artifact.targetRef !== initial.entry.asset.ref || prepared.execution.dependencies.length
      || prepared.execution.permissions.length || prepared.execution.sideEffects !== 'none'
      || prepared.execution.timeoutMs > initial.grant.limits.timeoutMs) return { status: 'blocked', code: 'unauthorized' };
    failureCode = 'insufficient_coverage';
    if (initial.entry.semantic.cases.length !== prepared.checks.length) return { status: 'blocked', code: failureCode };
    const cases: ProposalRuntimeHarness['cases'] = [];
    for (const check of prepared.checks) {
      options.checkBudget(options);
      const configured = initial.entry.semantic.cases.find(entry => entry.checkId === check.id);
      if (!configured || configured.checkDigest !== digest(check)) return { status: 'blocked', code: failureCode };
      const experiment = prepareProposalExperiment(prepared.kind, initial.entry.asset.path, check, configured.experiment,
        prepared.proposal.kind === 'tool' ? prepared.proposal.payload.inputSchema : undefined);
      if (experiment.status !== 'prepared') return { status: 'blocked', code: failureCode };
      cases.push({ checkId: check.id, checkDigest: configured.checkDigest, argv: [...experiment.experiment.argv],
        experiment: proposalSemanticConfigurationSchema.parse(configured.experiment), expected: { protocol: initial.entry.semantic.protocol,
          adapter: initial.entry.semantic.adapter, assertions: configured.experiment.assertions } });
    }
    failureCode = 'checker_unavailable';
    const current = authorization(options);
    const repository = await options.resolveRepository?.({ scope: current.entry.scope, checkerId: options.checkerId,
      providerId: current.entry.repository.providerId, configurationDigest: current.configurationDigest,
      authorizationDigest: current.authorizationDigest }, options);
    authorization(options);
    if (!repository || repository.id !== current.entry.repository.providerId
      || (['read', 'prepare', 'checkout', 'cleanup'] as const).some(capability => repository.capabilities[capability] !== true)
      || typeof repository.snapshot !== 'function' || typeof repository.prepare !== 'function'
      || typeof repository.checkout !== 'function' || typeof repository.cleanup !== 'function'
      || typeof repository.withLifecycleLease !== 'function') return { status: 'blocked', code: failureCode };
    const identity = [repository.snapshot, repository.prepare, repository.checkout, repository.cleanup, repository.withLifecycleLease];
    const capabilities = canonicalLearningJson(repository.capabilities);
    const baseline = snapshotSchema.parse(await repository.snapshot(current.entry.repository.repository, options));
    authorization(options);
    const gitSnapshot = (operation: ProviderOperationOptions) => {
      options.checkBudget(operation);
      const root = current.entry.repository.root;
      if (realpathSync(root) !== root) throw new Error('proposal_repository_changed');
      const environment = { ...process.env };
      for (const name of Object.keys(environment)) if (name.startsWith('GIT_')) delete environment[name];
      Object.assign(environment, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_TERMINAL_PROMPT: '0', GIT_NO_REPLACE_OBJECTS: '1' });
      const git = (...args: string[]) => {
        options.checkBudget(operation);
        const output = execFileSync('git', ['--no-optional-locks', '-c', 'core.hooksPath=/dev/null',
          '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false',
          '-C', root, ...args], { env: environment, maxBuffer: 4 * 1024 * 1024,
          timeout: Math.max(1, Math.min(15_000, options.remainingMs())), killSignal: 'SIGKILL', encoding: 'utf8', stdio: 'pipe' });
        options.checkBudget(operation);
        return output;
      };
      if (git('rev-parse', '--show-toplevel').trim() !== root) throw new Error('proposal_repository_changed');
      const snapshot = { commit: git('rev-parse', 'HEAD').trim(), branch: git('branch', '--show-current').trim(),
        dirty: git('status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored=matching').length !== 0 };
      if (snapshot.dirty || snapshot.commit !== current.entry.repository.expectedCommit || !same(snapshot, baseline)) {
        throw new Error('proposal_repository_changed');
      }
      return snapshot;
    };
    const assertCurrent = (operation: ProviderOperationOptions) => {
      authorization(operation);
      const functions = [repository.snapshot, repository.prepare, repository.checkout, repository.cleanup, repository.withLifecycleLease];
      if (repository.id !== current.entry.repository.providerId || canonicalLearningJson(repository.capabilities) !== capabilities
        || functions.some((method, index) => method !== identity[index])) throw new Error('proposal_repository_changed');
      const { stored, sources } = options.evidenceSources(candidate, current.entry);
      if (stored.digest !== candidate.evidenceDigest || sources.some(source => {
        options.checkBudget(operation);
        return createHash('sha256').update(readValidationSnapshotFile(source.path, source.allowedRoot, 64 * 1024 * 1024))
          .digest('hex') !== source.expectedDigest;
      })) throw new Error('proposal_source_changed');
      const snapshot = gitSnapshot(operation);
      options.checkBudget(operation);
      return snapshot;
    };
    const snapshot = assertCurrent(options);
    const engine = new DockerContainerProvider();
    const checker: ProposalValidationChecker = { id: options.checkerId, version: current.entry.version,
      runtimeVersion: PROPOSAL_VALIDATION_RUNTIME_REVISION, configurationDigest: current.configurationDigest,
      target: { scope: current.entry.scope, ref: current.entry.repository.repository.url,
        revision: snapshot.commit, snapshotDigest: digest(snapshot) },
      runtime: { repository, request: { repository: current.entry.repository.repository, runId: randomUUID() },
        expectedCommit: snapshot.commit, inventory: catalog.inventory, inventoryDigest: catalog.inventoryDigest,
        inventoryRoot: current.entry.repository.root, artifactPath: current.entry.asset.path, baseImageId: current.entry.sandbox.baseImageId,
        ...(scratchHelper === undefined ? {} : { scratchHelper }),
        harness: { id: current.entry.semantic.adapter, revision: current.entry.semantic.revision, kind: prepared.kind, cases,
          observe: async () => ({ status: 'unsupported', reason: 'Dedicated semantic observations are required' }) },
        sandbox: { limits: { ...current.grant.limits }, remainingMs: options.remainingMs.bind(options), executeFrozen: async input => {
          assertCurrent({ signal: input.signal });
          const result = await executeFrozenContainer(engine, input);
          assertCurrent({ signal: input.signal });
          return result;
        } },
        assertCurrent: async (_binding, operation) => { assertCurrent(operation); },
        recordOwnership: async (ownership, binding, check) => {
          assertCurrent(options);
          options.store.recordProposalOwnership({ ownership, binding, check }, () => { assertCurrent(options); });
          assertCurrent(options);
        } },
    };
    return { status: 'ready', dependencies: { store: options.store,
      authorize: async (_candidate, operation) => ({ allowed: true, authorizationDigest: authorization(operation).authorizationDigest }),
      reconcile: async (_candidate, operation) => reconcile(operation),
      resolveChecker: async (_candidate, checkerId, operation) => {
        if (checkerId !== options.checkerId) return undefined;
        assertCurrent(operation);
        return checker;
      },
      readCommitSnapshot: () => {
        assertCurrent(options);
        return { checker, authorization: { allowed: true, authorizationDigest: authorization(options).authorizationDigest },
          source: { current: true, evidenceDigest: candidate.evidenceDigest } };
      },
    } };
  } catch {
    options.checkBudget(options);
    return { status: 'blocked', code: failureCode };
  }
}
