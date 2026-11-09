import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProviderOperationOptions, RepositoryPrepareRequest, RepositoryProvider, RepositoryWorkspace, RepositoryWorkspaceRequest } from '../../plugin-sdk/capabilities.js';
import { RemoteWorkspaceProvider } from '../../infrastructure/providers/repositories.js';
import { RepositoryLifecycleService } from './repository-lifecycle.js';

const input = { repository: { url: 'repo', ref: 'main' }, runId: 'run-1' };
const prepared: RepositoryWorkspace = { id: 'workspace-1', ...input,
  snapshot: { commit: 'a'.repeat(40), branch: 'HEAD', dirty: false } };
const checkedOut = { ...prepared, snapshot: { ...prepared.snapshot, branch: 'afk/run-1' } };
const publication = { commit: checkedOut.snapshot.commit, branch: checkedOut.snapshot.branch };

function fixture() {
  const provider = {
    id: 'fixture', capabilities: { read: true, clone: false, push: false, prepare: true, checkout: true, publish: true, cleanup: true },
    snapshot: vi.fn(async () => prepared.snapshot),
    prepare: vi.fn(async () => prepared),
    checkout: vi.fn(async () => checkedOut),
    publish: vi.fn(async () => publication),
    cleanup: vi.fn(async (_request: RepositoryWorkspaceRequest, _options?: ProviderOperationOptions) => ({ removed: true })),
  } satisfies RepositoryProvider;
  const service = new RepositoryLifecycleService(provider);
  return { provider, service };
}

afterEach(() => { vi.useRealTimers(); });

describe('RepositoryLifecycleService', () => {
  it('connects actual provider operations to execution in lifecycle order', async () => {
    const order: string[] = [];
    const transport = vi.fn(async (url: unknown) => {
      const operation = String(url).split('/').at(-1)!;
      order.push(operation);
      const response = operation === 'prepare' ? prepared : operation === 'checkout' ? checkedOut
        : operation === 'snapshot' ? checkedOut.snapshot : operation === 'publish' ? publication : { removed: true };
      return new Response(JSON.stringify(response));
    });
    const provider = new RemoteWorkspaceProvider({ baseUrl: 'https://workspace.example', transport,
      lifecycle: { repositories: [input.repository], operations: ['prepare', 'checkout', 'publish', 'cleanup'] } });
    const result = await new RepositoryLifecycleService(provider).run(input, async workspace => {
      order.push('execute');
      expect(workspace).toEqual(checkedOut);
      expect(workspace.path).toBeUndefined();
      return 'result';
    });
    expect(order).toEqual(['prepare', 'checkout', 'execute', 'snapshot', 'publish', 'snapshot', 'cleanup']);
    expect(result).toEqual({ value: 'result', workspace: checkedOut, publication, cleanup: { removed: true } });
  });

  it('forwards cancellation to execution operations and uses an independent cleanup signal', async () => {
    const { provider, service } = fixture();
    const options = { signal: new AbortController().signal };
    await service.run(input, async () => 'ok', options);
    expect(provider.prepare).toHaveBeenCalledWith(input, options);
    for (const operation of [provider.checkout, provider.publish]) {
      expect(operation).toHaveBeenCalledWith({ workspaceId: prepared.id }, options);
    }
    const cleanupOptions = provider.cleanup.mock.calls[0][1]!;
    expect(cleanupOptions.signal).not.toBe(options.signal);
    expect(cleanupOptions.signal?.aborted).toBe(false);
  });

  it.each(['prepare', 'checkout', 'publish', 'cleanup'] as const)('rejects missing %s capability before preparation', async operation => {
    const { provider } = fixture();
    const service = new RepositoryLifecycleService({ ...provider, capabilities: { ...provider.capabilities, [operation]: false } });
    await expect(service.run(input, async () => 'ok')).rejects.toThrow(`does not support ${operation}`);
    expect(provider.prepare).not.toHaveBeenCalled();
  });

  it('rejects a claimed capability with no implementation before preparation', async () => {
    const { provider } = fixture();
    const withoutPublish = { ...provider, publish: undefined };
    await expect(new RepositoryLifecycleService(withoutPublish).run(input, async () => 'ok')).rejects.toThrow('does not support publish');
    expect(provider.prepare).not.toHaveBeenCalled();
  });

  it('does not publish failed execution and cleans up through provider ownership checks', async () => {
    const { provider, service } = fixture();
    const failure = new Error('execution failed');
    await expect(service.run(input, async () => { throw failure; })).rejects.toBe(failure);
    expect(provider.publish).not.toHaveBeenCalled();
    expect(provider.cleanup).toHaveBeenCalledOnce();
  });

  it('preserves execution and cleanup failures together', async () => {
    const { provider, service } = fixture();
    const failure = new Error('execution failed');
    const cleanup = new Error('dirty workspace retained');
    provider.cleanup.mockRejectedValueOnce(cleanup);
    await expect(service.run(input, async () => { throw failure; })).rejects.toMatchObject({ errors: [failure, cleanup] });
    expect(provider.publish).not.toHaveBeenCalled();
  });

  it('cleans up after checkout or publication failure and reports refused cleanup', async () => {
    const first = fixture();
    first.provider.checkout.mockRejectedValueOnce(new Error('checkout failed'));
    const execute = vi.fn(async () => 'ok');
    await expect(first.service.run(input, execute)).rejects.toThrow('checkout failed');
    expect(execute).not.toHaveBeenCalled();
    expect(first.provider.cleanup).toHaveBeenCalledOnce();
    const second = fixture();
    second.provider.publish.mockRejectedValueOnce(new Error('publication failed'));
    await expect(second.service.run(input, execute)).rejects.toThrow('publication failed');
    expect(second.provider.cleanup).toHaveBeenCalledOnce();
    const third = fixture();
    third.provider.cleanup.mockResolvedValueOnce({ removed: false });
    await expect(third.service.run(input, execute)).rejects.toThrow('cleanup was refused');
  });

  it('does not execute or publish after cancellation', async () => {
    const { provider, service } = fixture();
    const controller = new AbortController();
    const execute = vi.fn(async () => { controller.abort(new Error('cancelled')); return 'ok'; });
    await expect(service.run(input, execute, { signal: controller.signal })).rejects.toThrow('cancelled');
    expect(provider.publish).not.toHaveBeenCalled();
    expect(provider.cleanup.mock.calls[0][1]?.signal).not.toBe(controller.signal);
    expect(provider.cleanup.mock.calls[0][1]?.signal?.aborted).toBe(false);
    provider.prepare.mockClear();
    await expect(service.run(input, execute, { signal: controller.signal })).rejects.toThrow('cancelled');
    expect(provider.prepare).not.toHaveBeenCalled();
  });

  it('invokes the optional lease scope around every phase including execution and cleanup', async () => {
    const { provider } = fixture();
    const mutableInput = { ...input, repository: { ...input.repository } };
    let leased = false;
    const assertLeased = () => { expect(leased).toBe(true); };
    provider.prepare.mockImplementationOnce(async () => { assertLeased(); return prepared; });
    provider.checkout.mockImplementationOnce(async () => { assertLeased(); return checkedOut; });
    provider.publish.mockImplementationOnce(async () => { assertLeased(); return publication; });
    provider.cleanup.mockImplementationOnce(async () => { assertLeased(); return { removed: true }; });
    const withLease: RepositoryProvider = { ...provider,
      withLifecycleLease: async <Result>(request: RepositoryPrepareRequest, operation: () => Promise<Result>, options?: ProviderOperationOptions): Promise<Result> => {
        expect(request).toEqual(input);
        expect(options?.signal?.aborted).toBe(false);
        mutableInput.repository.url = 'other-repository';
        leased = true;
        try { return await operation(); } finally { leased = false; }
      } };
    await new RepositoryLifecycleService(withLease).run(mutableInput, async () => { assertLeased(); return 'ok'; }, { signal: new AbortController().signal });
    expect(provider.prepare).toHaveBeenCalledWith(input, expect.anything());
    expect(leased).toBe(false);
  });

  it.each(['clean', 'dirty', 'unpublished'] as const)('performs actual backend cleanup after cancellation while preserving %s work rules', async state => {
    const operations: string[] = [];
    const transport = vi.fn(async (url: unknown, init?: RequestInit) => {
      expect(init?.signal?.aborted).toBe(false);
      const operation = String(url).split('/').at(-1)!;
      operations.push(operation);
      const response = operation === 'prepare' ? prepared : operation === 'checkout' ? checkedOut
        : operation === 'snapshot' ? { ...checkedOut.snapshot, dirty: state === 'dirty',
          commit: state === 'unpublished' ? 'b'.repeat(40) : checkedOut.snapshot.commit } : { removed: true };
      return new Response(JSON.stringify(response));
    });
    const provider = new RemoteWorkspaceProvider({ baseUrl: 'https://workspace.example', transport,
      lifecycle: { repositories: [input.repository], operations: ['prepare', 'checkout', 'publish', 'cleanup'] } });
    const controller = new AbortController();
    const cancelled = new Error('cancelled execution');
    const pending = new RepositoryLifecycleService(provider).run(input, async () => { controller.abort(cancelled); }, { signal: controller.signal });
    if (state === 'clean') {
      await expect(pending).rejects.toBe(cancelled);
      expect(operations).toEqual(['prepare', 'checkout', 'snapshot', 'cleanup']);
    } else {
      await expect(pending).rejects.toMatchObject({ errors: [cancelled, expect.objectContaining({ message: expect.stringContaining(state) })] });
      expect(operations).toEqual(['prepare', 'checkout', 'snapshot']);
    }
  });

  it('bounds the independent cleanup signal and clears its timer', async () => {
    vi.useFakeTimers();
    const { provider, service } = fixture();
    provider.cleanup.mockImplementationOnce(async (_request, options) => new Promise<never>((_resolve, reject) => {
      options!.signal!.addEventListener('abort', () => reject(options!.signal!.reason), { once: true });
    }));
    const pending = service.run(input, async () => 'ok');
    const assertion = expect(pending).rejects.toThrow('repository cleanup timed out');
    await vi.advanceTimersByTimeAsync(0);
    expect(provider.cleanup).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(15_000);
    await assertion;
    expect(vi.getTimerCount()).toBe(0);
  });
});
