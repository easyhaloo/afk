import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WorktreeManager } from '../../infrastructure/git/worktree.js';
import { createRemoteContainerServer } from '../../infrastructure/sandbox/remote-container-server.js';
import type { PluginRuntime } from './runtime.js';

export interface RemoteContainerServiceOptions {
  readonly token: string;
  readonly repositoryRoot: string;
  readonly workspaceRoot: string;
  readonly sandboxProviderId: string;
  readonly allowedAgents: readonly string[];
  readonly host?: string;
  readonly port?: number;
  readonly allowRemote?: boolean;
}

export async function startRemoteContainerService(runtime: PluginRuntime, options: RemoteContainerServiceOptions) {
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 8375;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid remote service port');
  if (!options.allowRemote && !['127.0.0.1', '::1', 'localhost'].includes(host)) throw new Error('Non-loopback binding requires --allow-remote');
  if (options.sandboxProviderId === 'remote-container') throw new Error('Remote service cannot forward back to the remote-container provider');
  const backend = createRemoteContainerServer({
    enabled: true, token: options.token, workspaceRoot: options.workspaceRoot,
    sandboxes: runtime.getSandboxProviderRegistry(), sandboxProviderId: options.sandboxProviderId,
    sandboxDeps: { worktreeManager: new WorktreeManager(options.repositoryRoot) },
    agents: runtime.getAgentProviderRegistry(), allowedAgents: options.allowedAgents, allowRemote: options.allowRemote,
  });
  const server = createServer({ requestTimeout: 30000, headersTimeout: 10000 }, backend.handle);
  let closing: Promise<void> | undefined;
  const close = () => closing ??= (async () => {
    const stopped = new Promise<void>((resolve, reject) => {
      server.close(error => error && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING' ? reject(error) : resolve());
    });
    server.closeAllConnections();
    try { await stopped; } finally { await backend.close(); }
  })();
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => { server.off('error', reject); resolve(); });
    });
  } catch (error) { await close(); throw error; }
  return { address: server.address() as AddressInfo, close };
}
