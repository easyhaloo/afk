import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Plugin, PluginSystemActionOptions } from './runtime.js';
import type { PluginFactoryOptions } from './loader.js';
import type { VerificationRequest, VerificationResult } from '../../plugin-sdk/capabilities.js';
import { CommandVerificationProvider, type VerificationCommandRunner } from '../../infrastructure/verification/command.js';
import { readInstalledPlugin } from './manager.js';
import { PLAYWRIGHT_PLUGIN_ID, PLAYWRIGHT_PROVIDER_ID, localToolTarget, verifyToolPackage } from './tool-recipes.js';

export async function createManagedPlaywrightPlugin(options: PluginFactoryOptions & { readonly packageRoot: string; readonly runner?: VerificationCommandRunner }): Promise<Plugin> {
  if (options.configuration.execution !== 'host-local' || Object.keys(options.configuration).some(key => key !== 'execution')) throw new Error('Managed Playwright requires explicit host-local configuration');
  const directory = join(options.homeDir, '.afk', 'plugins', PLAYWRIGHT_PLUGIN_ID);
  const record = await readInstalledPlugin(directory);
  if (!record || record.id !== PLAYWRIGHT_PLUGIN_ID || !record.toolReceipt) throw new Error('Managed Playwright installation receipt is missing');
  if (await fs.realpath(options.packageRoot) !== await fs.realpath(dirname(join(directory, record.entry)))) throw new Error('Managed tool installation path mismatch');
  const seal = await verifyToolPackage(options.packageRoot, record.toolReceipt);
  const command = [process.execPath, join(options.packageRoot, seal.cli), 'test'];
  const delegate = new CommandVerificationProvider(PLAYWRIGHT_PROVIDER_ID, 'test-execution', command, { runner: options.runner });
  const operations = new Map<Promise<VerificationResult>, AbortController>();
  let disposed = false;
  const provider = {
    id: PLAYWRIGHT_PROVIDER_ID,
    capabilities: { 'static-analysis': false, 'test-execution': true, 'custom-script': false },
    verify(request: VerificationRequest, invocation: PluginSystemActionOptions = {}): Promise<VerificationResult> {
      if (disposed) return Promise.reject(new Error('Managed Playwright provider is disposed'));
      const controller = new AbortController();
      const abort = () => controller.abort(invocation.signal?.reason);
      invocation.signal?.addEventListener('abort', abort, { once: true });
      if (invocation.signal?.aborted) abort();
      const operation = Promise.resolve().then(async () => {
        controller.signal.throwIfAborted();
        if (request.command !== undefined) throw new Error('Managed recipe does not authorize request command overrides');
        const target = await localToolTarget(invocation.authorizedWorkspace ?? options.workspaceRoot, request.target);
        await verifyToolPackage(options.packageRoot, record.toolReceipt!);
        controller.signal.throwIfAborted();
        return delegate.verify({ target, timeoutMs: request.timeoutMs }, { signal: controller.signal });
      }).finally(() => {
        invocation.signal?.removeEventListener('abort', abort);
        operations.delete(operation);
      });
      operations.set(operation, controller);
      return operation;
    },
  };
  return {
    manifest: record.manifest,
    activate(context) {
      context.onDispose(async () => {
        disposed = true;
        for (const controller of operations.values()) controller.abort(new Error('Managed tool deactivated'));
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            Promise.allSettled([...operations.keys()]),
            new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Managed tool cleanup unconfirmed; active ownership retained')), 1000); }),
          ]);
        } finally { clearTimeout(timer); }
      });
      context.registerVerificationProvider(PLAYWRIGHT_PROVIDER_ID, provider);
    },
    health: () => ({ status: 'unknown', message: 'CLI closure installed; browser payload, OS dependencies and project test configuration require separate provisioning' }),
    diagnostics: () => [{ severity: 'info', code: 'tool.local-only', message: 'Managed Playwright supports only the authorized local workspace; browser/native/backend delivery is not provided', details: { command, recipe: seal.recipe, platform: seal.platform, architecture: seal.architecture } }],
  };
}
