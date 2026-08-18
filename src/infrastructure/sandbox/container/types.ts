/**
 * Container provider types — engine-agnostic abstraction over Docker/Podman
 * for the container sandbox (EXECUTION-DESIGN.md §6).
 *
 * ContainerProvider runs ONE long-lived container per workflow. Each
 * context handoff restarts the Agent process inside the same container
 * (preserves deps + cache, keeps generation boundary clean). The container
 * is bind-mounted from the host worktree at /workspace; AFK control files
 * are written to /afk/{session,result}.
 *
 * The provider exposes the smallest surface needed by ContainerSandbox:
 *   create()      — docker run with validated mounts + env allowlist
 *   exec()        — docker exec with the captured exec_id (for streaming
 *                   and interrupt targeting)
 *   killExec()    — interrupt a specific exec (SIGINT / SIGTERM / SIGKILL)
 *   killContainer() — force-stop the container
 *   remove()      — docker rm -f
 *   inspect()     — running state, PID, mount verification
 *
 * Providers MUST validate every volume mount and every env var before
 * passing them to the engine. The design forbids mounting ~/.ssh, ~/.aws,
 * the docker socket, or sibling repos; the allowlist is enforced here.
 */

export type ContainerEngine = 'docker' | 'podman';

export type ContainerStatus = 'created' | 'running' | 'exited' | 'dead' | 'unknown';

/** Options for ContainerProvider.create(). */
export interface ContainerCreateOptions {
  /** Image to run (e.g. 'alpine:3.20', 'node:20-slim'). */
  image: string;
  /** Container name — used by exec/kill/rm. Must be unique per workflow. */
  name: string;
  /** UID:GID to run as — non-root is mandatory per the design. */
  user: string;
  /** Bind mounts (host path -> container path). Validated against allowlist. */
  mounts: ContainerMount[];
  /** Env vars to inject — names validated against EnvVarAllowlist. */
  env: Record<string, string>;
  /** Command to run as PID 1 (e.g. ['sleep', 'infinity']). */
  command: string[];
  /** Drop ALL Linux capabilities then add only what's needed. */
  dropCapabilities?: string[];
  /** Read-only root filesystem (best practice for untrusted code). */
  readOnlyRoot?: boolean;
  /** Working directory inside the container. */
  workdir?: string;
}

/** Single bind mount, with optional read-only flag. */
export interface ContainerMount {
  hostPath: string;
  containerPath: string;
  readOnly?: boolean;
}

/** Result of create(). Holds the identifiers needed by all subsequent calls. */
export interface ContainerHandle {
  id: string;
  name: string;
  /** Engine that owns this container (docker/podman). */
  engine: ContainerEngine;
  /** Initial exec_id returned by `docker exec` of the PID-1 command, if any. */
  execId?: string;
}

/** Options for exec(). */
export interface ContainerExecOptions {
  containerId: string;
  command: string[];
  env?: Record<string, string>;
  /** Optional stdin supplied to the in-container command. */
  stdin?: string;
  /** If true, return a stream handle instead of waiting for completion. */
  detach?: boolean;
  /** Working directory inside the container. */
  workdir?: string;
}

/** Result of exec(). */
export interface ContainerExecResult {
  /** Engine-assigned exec_id — used to kill a specific exec instance. */
  execId: string;
  /** Exit code (only present when wait=true). */
  exitCode?: number;
  /** Captured stdout (when not streaming). */
  stdout?: string;
  /** Captured stderr (when not streaming). */
  stderr?: string;
}

/** Inspection result. */
export interface ContainerInspectInfo {
  id: string;
  name: string;
  status: ContainerStatus;
  pid?: number;
  /** Mount table — verifies that the bind mounts we requested actually landed. */
  mounts?: Array<{ source: string; destination: string; readOnly: boolean }>;
}

/** Errors thrown by container providers. */
export class ContainerError extends Error {
  constructor(message: string, public readonly engine: ContainerEngine, public readonly cause?: unknown) {
    super(`[${engine}] ${message}`);
    this.name = 'ContainerError';
  }
}

/**
 * Engine-agnostic container provider. Concrete implementations live in
 * docker.ts and podman.ts; both share the same CLI flag surface for run,
 * exec, kill, rm so the implementations are mostly one-liners.
 */
export interface ContainerProvider {
  readonly engine: ContainerEngine;
  readonly binary: string;

  /** True if the binary is on PATH and the daemon/rootless state is usable. */
  isAvailable(): Promise<boolean>;

  /** Run a long-lived container; returns identifiers needed by subsequent calls. */
  create(options: ContainerCreateOptions): Promise<ContainerHandle>;

  /** Run a command inside a running container. */
  exec(options: ContainerExecOptions): Promise<ContainerExecResult>;

  /** Send a signal to a specific exec (graceful interrupt path). */
  killExec(execId: string, signal?: string): Promise<void>;

  /** Force-stop the container (last-resort cleanup). */
  killContainer(containerId: string, signal?: string): Promise<void>;

  /** Remove the container. Idempotent — ENOENT is silently swallowed. */
  remove(containerId: string, force?: boolean): Promise<void>;

  /** Read container state + mount table. */
  inspect(containerId: string): Promise<ContainerInspectInfo>;
}
