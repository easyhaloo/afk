import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createDefaultPluginRuntime } from './default-runtime.js';
import { startRemoteContainerService } from './remote-service.js';
import { createRemoteContainerHttpTransport } from '../../infrastructure/sandbox/remote-container.js';

it('serves registered capabilities with authentication and closes idempotently', async () => {
  const root = await mkdtemp(join(tmpdir(), 'remote-service-'));
  const token = 'remote-service-test-token-at-least-32-bytes';
  const runtime = await createDefaultPluginRuntime({ homeDir: root, workspaceRoot: root });
  const options = { token, repositoryRoot: root, workspaceRoot: root, sandboxProviderId: 'local', allowedAgents: ['codex'], port: 0 };
  let service: Awaited<ReturnType<typeof startRemoteContainerService>> | undefined;
  try {
    await expect(startRemoteContainerService(runtime, { ...options, host: '0.0.0.0' })).rejects.toThrow('--allow-remote');
    await expect(startRemoteContainerService(runtime, { ...options, sandboxProviderId: 'remote-container' })).rejects.toThrow('cannot forward');
    service = await startRemoteContainerService(runtime, options);
    const baseUrl = `http://127.0.0.1:${service.address.port}/`;
    expect((await fetch(`${baseUrl}health`)).status).toBe(401);
    expect(await createRemoteContainerHttpTransport({ baseUrl, token }).health!()).toBe(true);
    await service.close();
    await service.close();
  } finally {
    await service?.close();
    await runtime.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
