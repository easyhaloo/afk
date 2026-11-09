/**
 * Sandbox provider registry — an extensible catalog of sandbox providers.
 *
 * The legacy surface was a closed union (`SandboxProviderName`) and a hard
 * `switch` in `createSandboxProvider`. That made it impossible to add a
 * provider (e.g. a plugin-registered one) without editing the sandbox module.
 *
 * The registry keeps the built-in providers (`local`, `docker`, `podman`)
 * available through the same `createSandboxProvider` factory, but lets callers
 * register additional providers with minimal metadata describing what the
 * provider can do (`capabilities`), whether it is ready to create sandboxes
 * (`readiness`), and how to read its current health (`health`).
 */

import type { SandboxCapability, SandboxProvider, SandboxProviderId } from './types.js';
import { LocalSandboxProvider } from './providers/local.js';
import { ContainerSandboxProvider, DockerContainerProvider, PodmanContainerProvider } from './providers/index.js';
import type { WorktreeManager } from '../git/index.js';

/** Dependencies every provider factory may draw on. */
export interface SandboxProviderDeps {
  worktreeManager: WorktreeManager;
}

/** Creates a ready-to-use provider. `options` is provider-defined. */
export type SandboxProviderFactory = (
  deps: SandboxProviderDeps,
  options: unknown,
) => SandboxProvider;

/** Static metadata describing a registered provider. */
export interface SandboxProviderMetadata {
  /** Stable provider id (the registry key). */
  readonly id: SandboxProviderId;
  /** Human-readable label for UIs / logs. */
  readonly label: string;
  /** What this provider can do. Defaults to the provider's own capabilities. */
  readonly capabilities: ReadonlySet<SandboxCapability>;
  /**
   * Is the provider ready to create sandboxes right now?
   * May be an async probe (e.g. "is the container engine on PATH?").
   * Defaults to ready.
   */
  readonly readiness: () => Promise<boolean> | boolean;
  /**
   * Point-in-time health snapshot. Defaults to `ready` per provider.
   * Returning `unknown` is valid when a provider has no live probe.
   */
  readonly health: () => Promise<SandboxProviderHealth> | SandboxProviderHealth;
}

/** Point-in-time provider health. */
export type SandboxProviderHealth = 'ready' | 'degraded' | 'unavailable' | 'unknown';

/** A registered provider: metadata + how to build it. */
export interface SandboxProviderDescriptor {
  readonly metadata: SandboxProviderMetadata;
  readonly factory: SandboxProviderFactory;
}

const alwaysReady = (): boolean => true;
const readyHealth = (): SandboxProviderHealth => 'ready';

function metadata(
  id: SandboxProviderId,
  label: string,
  overrides: Partial<Omit<SandboxProviderMetadata, 'id' | 'label'>> = {},
): SandboxProviderMetadata {
  return {
    id,
    label,
    capabilities: new Set<SandboxCapability>(),
    readiness: alwaysReady,
    health: readyHealth,
    ...overrides,
  };
}

/** Registry of sandbox providers keyed by provider id. */
export class SandboxProviderRegistry {
  private readonly descriptors = new Map<SandboxProviderId, SandboxProviderDescriptor>();

  /** Register (or replace) a provider. */
  register(descriptor: SandboxProviderDescriptor): this {
    this.descriptors.set(descriptor.metadata.id, descriptor);
    return this;
  }

  /** True if a provider with this id is registered. */
  has(id: SandboxProviderId): boolean {
    return this.descriptors.has(id);
  }

  /** Look up a descriptor by id. */
  get(id: SandboxProviderId): SandboxProviderDescriptor | undefined {
    return this.descriptors.get(id);
  }

  /** Remove a provider. Returns true when a provider was removed. */
  unregister(id: SandboxProviderId): boolean {
    return this.descriptors.delete(id);
  }

  /** All registered provider ids. */
  ids(): SandboxProviderId[] {
    return [...this.descriptors.keys()];
  }

  /** All registered metadata, for UIs and diagnostics. */
  list(): SandboxProviderMetadata[] {
    return [...this.descriptors.values()].map(d => d.metadata);
  }

  /**
   * Build a provider instance. Throws when the id is unknown so a typo fails
   * loudly rather than silently falling back to another provider.
   */
  create(id: SandboxProviderId, deps: SandboxProviderDeps, options?: unknown): SandboxProvider {
    const descriptor = this.descriptors.get(id);
    if (!descriptor) {
      throw new Error(
        `unknown sandbox provider '${id}' (registered: ${this.ids().join(', ') || 'none'})`,
      );
    }
    return descriptor.factory(deps, options);
  }

  /** Register the built-in local/docker/podman providers. Idempotent. */
  registerBuiltins(): this {
    this.register(localDescriptor());
    this.register(dockerDescriptor());
    this.register(podmanDescriptor());
    return this;
  }
}

/** Shared container readiness probe for docker/podman. */
async function containerReadiness(engine: 'docker' | 'podman'): Promise<boolean> {
  const provider = engine === 'podman' ? new PodmanContainerProvider() : new DockerContainerProvider();
  return provider.isAvailable();
}

function localDescriptor(): SandboxProviderDescriptor {
  return {
    metadata: metadata('local', 'Local (worktree + tmux)', {
      capabilities: new Set<SandboxCapability>([
        'streaming-exec',
        'interrupt-process',
        'kill-process',
        'persistent-filesystem',
        'copy-files',
        'session-transfer',
      ]),
    }),
    factory: deps => new LocalSandboxProvider(deps.worktreeManager),
  };
}

function containerDescriptor(
  id: 'docker' | 'podman',
  label: string,
  engine: 'docker' | 'podman',
): SandboxProviderDescriptor {
  const capabilities = new Set<SandboxCapability>([
    'persistent-filesystem',
    'copy-files',
    'kill-process',
    'interrupt-process',
    'session-transfer',
  ]);
  return {
    metadata: metadata(id, label, {
      capabilities,
      readiness: () => containerReadiness(engine),
      health: async () => ((await containerReadiness(engine)) ? 'ready' : 'unavailable'),
    }),
    factory: (deps, options) => {
      const opts = (options ?? {}) as { provider?: DockerContainerProvider | PodmanContainerProvider };
      return new ContainerSandboxProvider({
        worktreeManager: deps.worktreeManager,
        provider: opts.provider ?? (engine === 'podman' ? new PodmanContainerProvider() : new DockerContainerProvider()),
      });
    },
  };
}

function dockerDescriptor(): SandboxProviderDescriptor {
  return containerDescriptor('docker', 'Docker container', 'docker');
}

function podmanDescriptor(): SandboxProviderDescriptor {
  return containerDescriptor('podman', 'Podman container', 'podman');
}

/**
 * Registry pre-loaded with the built-in providers. Extension points that want
 * a shared catalog (e.g. plugin-registered providers) can use this instance;
 * callers that need isolation can construct their own `SandboxProviderRegistry`.
 */
export const defaultSandboxProviderRegistry: SandboxProviderRegistry =
  new SandboxProviderRegistry().registerBuiltins();
