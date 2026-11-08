/**
 * Sandbox — unified execution environment abstraction.
 *
 * Public surface:
 * - Types (SandboxProvider, Sandbox, AgentExecution, ExecutionResult, etc.)
 * - Provider implementations (local, docker, podman)
 * - Factory: createSandboxProvider()
 *
 * Import from here rather than from individual sub-modules.
 */
export * from './types.js';
export * from './providers/index.js';
export * from './registry.js';

import type { SandboxProvider, SandboxProviderId, SandboxProviderName } from './types.js';
import { defaultSandboxProviderRegistry } from './registry.js';
import type { SandboxProviderDeps } from './registry.js';
import type { WorktreeManager } from '../git/index.js';

/**
 * Compatibility factory: resolve a provider id to a ready-to-use SandboxProvider.
 *
 * This is now a thin wrapper over the default SandboxProviderRegistry, which
 * keeps the built-in `local`, `docker`, and `podman` providers available with
 * their existing constructors and exports. New providers should register with
 * the registry rather than extending this function.
 *
 * `name` accepts the legacy `SandboxProviderName` union as well as any
 * registered `SandboxProviderId`.
 */
export function createSandboxProvider(
  name: SandboxProviderName | SandboxProviderId,
  deps: { worktreeManager: WorktreeManager },
): SandboxProvider {
  return defaultSandboxProviderRegistry.create(name, deps as SandboxProviderDeps);
}
