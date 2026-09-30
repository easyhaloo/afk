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

import { LocalSandboxProvider } from './providers/local.js';
import { ContainerSandboxProvider, DockerContainerProvider, PodmanContainerProvider } from './providers/index.js';
import type { SandboxProviderName } from './types.js';
import type { WorktreeManager } from '../git/index.js';

/**
 * Factory: resolve a SandboxProviderName to a SandboxProvider instance.
 * All provider-internal assembly is encapsulated here — callers only get
 * the ready-to-use provider.
 */
export function createSandboxProvider(
  name: SandboxProviderName,
  deps: { worktreeManager: WorktreeManager },
): import('./types.js').SandboxProvider {
  switch (name) {
    case 'local':
      return new LocalSandboxProvider(deps.worktreeManager);
    case 'docker':
      return new ContainerSandboxProvider({ provider: new DockerContainerProvider() });
    case 'podman':
      return new ContainerSandboxProvider({ provider: new PodmanContainerProvider() });
  }
}
