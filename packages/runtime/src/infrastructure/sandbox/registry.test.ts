import { describe, it, expect, vi } from 'vitest';
import { WorktreeManager } from '../git/index.js';
import {
  SandboxProviderRegistry,
  defaultSandboxProviderRegistry,
} from './registry.js';
import { createSandboxProvider } from './index.js';
import { LocalSandboxProvider } from './providers/local.js';
import { ContainerSandboxProvider } from './container/provider.js';
import { DockerContainerProvider } from './container/docker.js';
import { PodmanContainerProvider } from './container/podman.js';
import type { SandboxProvider, SandboxProviderName } from './types.js';

const deps = { worktreeManager: new WorktreeManager() };

describe('SandboxProviderRegistry', () => {
  it('ships the built-in local/docker/podman providers with metadata', () => {
    const registry = new SandboxProviderRegistry().registerBuiltins();

    expect(registry.ids()).toEqual(['local', 'docker', 'podman']);
    expect(registry.has('local')).toBe(true);
    expect(registry.has('nope')).toBe(false);

    const local = registry.get('local')!;
    expect(local.metadata.label).toBe('Local (worktree + tmux)');
    expect(local.metadata.capabilities.has('streaming-exec')).toBe(true);
    expect(local.metadata.capabilities.has('session-transfer')).toBe(true);
    expect(local.metadata.readiness()).toBe(true);
    expect(local.metadata.health()).toBe('ready');
  });

  it('exposes capability/readiness/health metadata for container providers', async () => {
    const docker = defaultSandboxProviderRegistry.get('docker')!;
    const podman = defaultSandboxProviderRegistry.get('podman')!;

    for (const entry of [docker, podman]) {
      expect(entry.metadata.capabilities.has('persistent-filesystem')).toBe(true);
      // No streaming-exec on containers yet.
      expect(entry.metadata.capabilities.has('streaming-exec')).toBe(false);
    }

    // Readiness/health probe the engine binary without requiring it on PATH.
    const dockerAvailable = vi
      .spyOn(DockerContainerProvider.prototype, 'isAvailable')
      .mockResolvedValue(false);
    const podmanAvailable = vi
      .spyOn(PodmanContainerProvider.prototype, 'isAvailable')
      .mockResolvedValue(false);

    await expect(docker.metadata.readiness()).resolves.toBe(false);
    await expect(podman.metadata.health()).resolves.toBe('unavailable');

    dockerAvailable.mockRestore();
    podmanAvailable.mockRestore();
  });

  it('creates the built-in providers', () => {
    const registry = new SandboxProviderRegistry().registerBuiltins();

    expect(registry.create('local', deps)).toBeInstanceOf(LocalSandboxProvider);
    expect(registry.create('docker', deps)).toBeInstanceOf(ContainerSandboxProvider);
    expect(registry.create('podman', deps)).toBeInstanceOf(ContainerSandboxProvider);
  });

  it('honours an injected container engine for docker/podman ids', () => {
    const registry = new SandboxProviderRegistry().registerBuiltins();
    const engine = new PodmanContainerProvider();

    const provider = registry.create('podman', deps, { provider: engine }) as ContainerSandboxProvider;
    expect(provider).toBeInstanceOf(ContainerSandboxProvider);
    // provider name mirrors the engine for container providers.
    expect(provider.name).toBe('podman');
  });

  it('registers a custom provider id without editing the sandbox module', () => {
    const registry = new SandboxProviderRegistry();
    const customId: SandboxProviderName = 'acme';
    const custom: SandboxProvider = {
      name: customId,
      isolation: 'vm',
      capabilities: new Set(['streaming-exec']),
      createWorktree: async () => ({ iid: 0, path: '', branch: '' }),
      create: async () => { throw new Error('not used'); },
    };

    registry.register({
      metadata: {
        id: customId,
        label: 'Acme VM',
        capabilities: new Set(['streaming-exec']),
        readiness: () => true,
        health: () => 'degraded',
      },
      factory: () => custom,
    });

    expect(registry.ids()).toEqual([customId]);
    expect(registry.create(customId, deps)).toBe(custom);
    expect(registry.list()).toEqual([
      expect.objectContaining({ id: 'acme', label: 'Acme VM' }),
    ]);
  });

  it('throws a helpful error for an unknown provider id', () => {
    const registry = new SandboxProviderRegistry().registerBuiltins();
    expect(() => registry.create('nope', deps)).toThrow(/unknown sandbox provider 'nope'/);
    expect(() => registry.create('nope', deps)).toThrow(/local, docker, podman/);
  });
});

describe('createSandboxProvider compatibility factory', () => {
  it('still resolves the built-in providers by name', () => {
    expect(createSandboxProvider('local', deps)).toBeInstanceOf(LocalSandboxProvider);
    expect(createSandboxProvider('docker', deps)).toBeInstanceOf(ContainerSandboxProvider);
    expect(createSandboxProvider('podman', deps)).toBeInstanceOf(ContainerSandboxProvider);
  });

  it('keeps the local provider name and capabilities intact', () => {
    const provider = createSandboxProvider('local', deps);
    expect(provider.name).toBe('local');
    expect(provider.isolation).toBe('workspace');
    expect(provider.capabilities.has('streaming-exec')).toBe(true);
  });

  it('delegates to the shared registry so registered providers resolve too', () => {
    const custom: SandboxProvider = {
      name: 'plugin-box',
      isolation: 'process',
      capabilities: new Set(),
      createWorktree: async () => ({ iid: 0, path: '', branch: '' }),
      create: async () => { throw new Error('not used'); },
    };
    defaultSandboxProviderRegistry.register({
      metadata: {
        id: 'plugin-box',
        label: 'Plugin box',
        capabilities: new Set(),
        readiness: () => true,
        health: () => 'ready',
      },
      factory: () => custom,
    });

    expect(createSandboxProvider('plugin-box', deps)).toBe(custom);
    // Remove the plugin provider so other suites see only the built-ins.
    expect(defaultSandboxProviderRegistry.unregister('plugin-box')).toBe(true);
    expect(() => createSandboxProvider('plugin-box', deps)).toThrow(/unknown sandbox provider/);
  });
});
