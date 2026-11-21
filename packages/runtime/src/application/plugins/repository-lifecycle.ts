import { AsyncLocalStorage } from 'node:async_hooks';
import { isAbsolute } from 'node:path';
import { realpath } from 'node:fs/promises';
import { simpleGit } from 'simple-git';
import type { Plugin, PluginRuntime } from './runtime.js';
import type { MultiRepositoryPreparationService, PreparedRepository, PreparedRepositorySet } from '../workflows/multi-repository-preparer.js';
import type { WorkflowRunRepository } from '../workflows/run-request.js';
import type { RunResourceScope } from '../workflows/resource-scope.js';
import type {
  ProviderOperationOptions,
  RepositoryCleanupResult,
  RepositoryLifecycleOperation,
  RepositoryRunRequest,
  RepositoryProvider,
  RepositoryPublication,
  RepositoryWorkspace,
} from '../../plugin-sdk/capabilities.js';

export interface RepositoryLifecycleResult<Result> {
  readonly value: Result;
  readonly workspace: RepositoryWorkspace;
  readonly publication: RepositoryPublication;
  readonly cleanup: RepositoryCleanupResult;
}

export class RepositoryLifecycleService {
  constructor(private readonly provider: RepositoryProvider) {}

  async run<Result>(input: RepositoryRunRequest, execute: (workspace: RepositoryWorkspace) => Promise<Result>,
    options?: ProviderOperationOptions): Promise<RepositoryLifecycleResult<Result>> {
    for (const operation of ['prepare', 'checkout', 'publish', 'cleanup'] as const) this.assertSupported(operation);
    this.checkAbort(options);
    const request = { repository: { ...input.repository }, runId: input.runId, ...(input.checkout === undefined ? {} : { checkout: {
      ...(input.checkout.branch === undefined ? {} : { branch: input.checkout.branch }),
      ...(input.checkout.ref === undefined ? {} : { ref: input.checkout.ref }),
    } }) };
    const operation = () => this.executeLifecycle(request, execute, options);
    return this.provider.withLifecycleLease ? this.provider.withLifecycleLease({ repository: request.repository, runId: request.runId }, operation, options) : operation();
  }

  private async executeLifecycle<Result>(input: RepositoryRunRequest, execute: (workspace: RepositoryWorkspace) => Promise<Result>,
    options?: ProviderOperationOptions): Promise<RepositoryLifecycleResult<Result>> {
    this.checkAbort(options);
    let workspace = await this.provider.prepare!({ repository: input.repository, runId: input.runId }, options);
    const request = { workspaceId: workspace.id };
    let failure: unknown;
    let failed = false;
    let value!: Result;
    let publication!: RepositoryPublication;
    try {
      this.checkAbort(options);
      workspace = await this.provider.checkout!({ ...request, ...input.checkout }, options);
      this.checkAbort(options);
      value = await execute(workspace);
      this.checkAbort(options);
      publication = await this.provider.publish!(request, options);
      this.checkAbort(options);
    } catch (error) {
      failure = error;
      failed = true;
    }
    let cleanup: RepositoryCleanupResult;
    const cleanupController = new AbortController();
    const cleanupTimeout = setTimeout(() => cleanupController.abort(new Error('repository cleanup timed out')), 15_000);
    try {
      cleanup = await this.provider.cleanup!(request, { signal: cleanupController.signal });
      if (!cleanup.removed) throw new Error('repository workspace cleanup was refused');
    } catch (error) {
      if (failed) throw new AggregateError([failure, error], 'repository execution and cleanup failed');
      throw error;
    } finally { clearTimeout(cleanupTimeout); }
    if (failed) throw failure;
    return { value, workspace, publication, cleanup };
  }

  private assertSupported(operation: RepositoryLifecycleOperation): void {
    if (!this.provider.capabilities[operation] || typeof this.provider[operation] !== 'function') {
      throw new Error(`repository provider does not support ${operation}`);
    }
  }

  private checkAbort(options?: ProviderOperationOptions): void {
    if (options?.signal?.aborted) throw options.signal.reason ?? new Error('repository lifecycle aborted');
  }
}

const repositorySelections = new WeakMap<PluginRuntime, { provider: string; integration: Plugin }>();

export function selectManagedRepository(runtime: PluginRuntime, provider: string, integration: Plugin): void {
  repositorySelections.set(runtime, { provider, integration });
}

export async function prepareManagedRepositories(input: {
  runtime?: PluginRuntime;
  fallback: MultiRepositoryPreparationService;
  repositories: readonly WorkflowRunRepository[];
  workspaceRoot: string;
  scope?: RunResourceScope;
  runId: string;
  verification?: boolean;
  verificationBranch?: string;
  options?: ProviderOperationOptions;
}): Promise<PreparedRepositorySet | undefined> {
  const selected = input.runtime && repositorySelections.get(input.runtime);
  if (!selected) return input.repositories.length
    ? input.fallback.prepare(input.repositories, input.workspaceRoot, input.scope?.cleanupOwnership) : undefined;
  if (input.runtime!.getPlugin('workflow.integrations') !== selected.integration) throw new Error('Selected Repository integration is unavailable');
  const provider = input.runtime!.getRepositoryProvider(selected.provider);
  if (!provider) throw new Error(`Selected Repository provider is unavailable: ${selected.provider}`);
  for (const operation of ['prepare', 'checkout', 'publish', 'cleanup'] as const) {
    if (!provider.capabilities[operation] || typeof provider[operation] !== 'function') throw new Error(`Selected Repository provider does not support ${operation}`);
  }
  if (!provider.withLifecycleLease || !provider.capabilities.read) throw new Error('Selected Repository provider requires lifecycle lease and read capabilities');
  if (input.verification && !input.verificationBranch) throw new Error('Selected Repository requires a trusted QA branch');
  if (!input.scope || input.repositories.filter(repository => repository.primary).length !== 1) throw new Error('Selected Repository requires managed repository ownership');
  if (input.options?.signal?.aborted) throw input.options.signal.reason ?? new Error('Repository preparation aborted');
  if (provider.health && (await provider.health()).status === 'unavailable') throw new Error('Selected Repository provider is unavailable');
  const prepared: PreparedRepository[] = [];
  const allocations: Array<{
    workspace?: RepositoryWorkspace;
    cleaned: boolean;
    published: boolean;
    invoke: ReturnType<typeof AsyncLocalStorage.snapshot>;
    release(): void;
    lease: Promise<unknown>;
    failure?: { error: unknown };
  }> = [];
  let terminal: Promise<void> | undefined;
  let complete = false;
  const heartbeat = async () => {
    if (input.runtime!.getRepositoryProvider(selected.provider) !== provider
      || input.runtime!.getPlugin('workflow.integrations') !== selected.integration) throw new Error('Selected Repository provider or integration was revoked');
    for (const allocation of allocations) if (allocation.failure) throw allocation.failure.error;
  };
  const publish = async (verified?: { path: string; commit: string }) => {
    await heartbeat();
    input.scope!.cleanupOwnership.assertClosed();
    for (const allocation of allocations) {
      if (allocation.published || !allocation.workspace) continue;
      if (allocation.cleaned) throw new Error('Selected Repository workspace is already cleaned');
      if (input.options?.signal?.aborted) throw input.options.signal.reason ?? new Error('Repository publication aborted');
      const git = simpleGit(allocation.workspace.path!);
      const expected = verified && verified.path === allocation.workspace.path ? verified.commit : undefined;
      if (expected && expected !== (await git.revparse(['HEAD'])).trim()) throw new Error('QA checkout moved before publication');
      const publication = await allocation.invoke(() => provider.publish!({ workspaceId: allocation.workspace!.id, ...(expected && { expectedCommit: expected }) }, input.options));
      if (expected && publication.commit !== expected) throw new Error('Repository published a different commit than QA verified');
      if (publication.branch !== allocation.workspace.snapshot.branch || publication.commit !== (await git.revparse(['HEAD'])).trim()
        || publication.branch !== (await git.revparse(['--abbrev-ref', 'HEAD'])).trim()) throw new Error('Repository publication changed workspace branch or omitted revision');
      if (input.options?.signal?.aborted) throw input.options.signal.reason ?? new Error('Repository publication aborted');
      allocation.published = true;
    }
  };
  const finish = (success: boolean): Promise<void> => {
    input.scope!.cleanupOwnership.assertClosed();
    if (complete) return Promise.resolve();
    return terminal ??= (async () => {
      if (success) await publish();
      for (const allocation of [...allocations].reverse()) {
        if (!allocation.workspace) throw new Error('Repository preparation returned no owned handle; cleanup unconfirmed');
        if (!allocation.cleaned) {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(new Error('Repository cleanup timed out')), 15_000);
          try {
            const result = await allocation.invoke(() => provider.cleanup!({ workspaceId: allocation.workspace!.id }, { signal: controller.signal }));
            if (!result.removed) throw new Error('Repository workspace cleanup was refused');
            allocation.cleaned = true;
          } finally { clearTimeout(timer); }
        }
        allocation.release();
        await allocation.lease;
      }
      complete = true;
    })().catch(error => { terminal = undefined; throw error; });
  };
  input.scope.registerExternalResource({ finish: outcome => finish(outcome.status === 'success' && !input.verification) });
  for (const repository of input.repositories) {
    if (input.options?.signal?.aborted) throw input.options.signal.reason ?? new Error('Repository preparation aborted');
    const request = { repository: { url: repository.name, ref: repository.baseBranch }, runId: input.runId };
    const ref = input.verification ? repository.workingBranch : repository.sourceBranch;
    const checkoutRequest = { branch: input.verification ? input.verificationBranch! : repository.workingBranch,
      ...(ref !== undefined && ref !== repository.baseBranch ? { ref } : {}) };
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let ready!: (invoke: ReturnType<typeof AsyncLocalStorage.snapshot>) => void;
    let rejected!: (error: unknown) => void;
    const acquired = new Promise<ReturnType<typeof AsyncLocalStorage.snapshot>>((resolve, reject) => { ready = resolve; rejected = reject; });
    let entered = false;
    const lease = provider.withLifecycleLease(request, async () => { entered = true; ready(AsyncLocalStorage.snapshot()); await gate; }, input.options);
    void lease.then(() => { if (!entered) rejected(new Error('Repository lifecycle lease did not execute its callback')); }, rejected);
    const allocation = { cleaned: false, published: false, invoke: await acquired, release, lease, workspace: undefined as RepositoryWorkspace | undefined, failure: undefined as { error: unknown } | undefined };
    void lease.catch(error => { allocation.failure = { error }; });
    allocations.push(allocation);
    await heartbeat();
    const workspace = await allocation.invoke(() => provider.prepare!(request, input.options));
    allocation.workspace = workspace;
    const validate = async (next: RepositoryWorkspace, checkout = false) => {
      if (!next.id || next.id !== workspace.id || next.runId !== request.runId || next.repository.url !== request.repository.url
        || next.repository.ref !== request.repository.ref || next.path !== workspace.path || !next.path || !isAbsolute(next.path)
        || await realpath(next.path) !== next.path || next.snapshot.dirty || !/^[a-f0-9]{7,64}$/i.test(next.snapshot.commit)
        || !next.snapshot.branch || ((!checkout || checkoutRequest.ref === undefined) && next.snapshot.commit !== workspace.snapshot.commit)) throw new Error('Selected Repository workspace identity or revision mismatch');
    };
    await heartbeat();
    await validate(workspace);
    if (input.options?.signal?.aborted) throw input.options.signal.reason ?? new Error('Repository preparation aborted');
    const checkout = await allocation.invoke(() => provider.checkout!({ workspaceId: workspace.id, ...checkoutRequest }, input.options));
    await heartbeat();
    await validate(checkout, true);
    const git = simpleGit(checkout.path!);
    if ((await git.revparse(['HEAD'])).trim() !== checkout.snapshot.commit
      || (await git.revparse(['--abbrev-ref', 'HEAD'])).trim() !== checkout.snapshot.branch) throw new Error('Selected Repository checkout revision differs from actual workspace');
    allocation.workspace = checkout;
    if (checkout.snapshot.branch !== (input.verification ? input.verificationBranch : repository.workingBranch)) throw new Error('Selected Repository checkout branch conflicts with trusted execution branch');
    if (input.options?.signal?.aborted) throw input.options.signal.reason ?? new Error('Repository checkout aborted');
    prepared.push({ ...repository, repoRoot: checkout.path!, workingBranch: checkout.snapshot.branch,
      handle: { path: checkout.path!, branch: checkout.snapshot.branch, isNewBranch: true }, createdByRun: true,
      original: { head: checkout.snapshot.commit, branch: checkout.snapshot.branch, status: '', workingBranchExisted: false } });
  }
  return { repositories: prepared, primary: prepared.find(repository => repository.primary)!, publish, heartbeat,
    finish: outcome => finish(outcome.status === 'success'), release: () => finish(false) };
}
