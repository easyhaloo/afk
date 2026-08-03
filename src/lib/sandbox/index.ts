/**
 * Sandbox — unified execution environment abstraction.
 *
 * Public surface:
 * - Types (SandboxProvider, Sandbox, AgentExecution, ExecutionResult, etc.)
 * - Provider implementations (local, docker, podman)
 *
 * Import from here rather than from individual sub-modules.
 */
export * from './types';
export * from './legacy-compat';
export * from './providers';
