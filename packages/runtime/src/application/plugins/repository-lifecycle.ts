import type {
  ProviderOperationOptions,
  RepositoryCleanupResult,
  RepositoryLifecycleOperation,
  RepositoryPrepareRequest,
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

  async run<Result>(input: RepositoryPrepareRequest, execute: (workspace: RepositoryWorkspace) => Promise<Result>,
    options?: ProviderOperationOptions): Promise<RepositoryLifecycleResult<Result>> {
    for (const operation of ['prepare', 'checkout', 'publish', 'cleanup'] as const) this.assertSupported(operation);
    this.checkAbort(options);
    const request = { repository: { ...input.repository }, runId: input.runId };
    const operation = () => this.executeLifecycle(request, execute, options);
    return this.provider.withLifecycleLease ? this.provider.withLifecycleLease(request, operation, options) : operation();
  }

  private async executeLifecycle<Result>(input: RepositoryPrepareRequest, execute: (workspace: RepositoryWorkspace) => Promise<Result>,
    options?: ProviderOperationOptions): Promise<RepositoryLifecycleResult<Result>> {
    this.checkAbort(options);
    let workspace = await this.provider.prepare!(input, options);
    const request = { workspaceId: workspace.id };
    let failure: unknown;
    let failed = false;
    let value!: Result;
    let publication!: RepositoryPublication;
    try {
      this.checkAbort(options);
      workspace = await this.provider.checkout!(request, options);
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
