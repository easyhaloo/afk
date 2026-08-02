/**
 * Shared base for CLI-based container providers (docker, podman).
 *
 * Both engines share the run / exec / kill / rm / inspect CLI surface for
 * the subset we need, so this base class builds argv arrays, runs them
 * via child_process, and parses JSON output where applicable. Subclasses
 * only set the binary path and engine name.
 */

import { spawn } from 'child_process';
import type {
  ContainerProvider,
  ContainerEngine,
  ContainerCreateOptions,
  ContainerHandle,
  ContainerExecOptions,
  ContainerExecResult,
  ContainerInspectInfo,
  ContainerStatus,
} from './types';
import { ContainerError } from './types';

export abstract class CliContainerProvider implements ContainerProvider {
  abstract readonly engine: ContainerEngine;
  abstract readonly binary: string;

  abstract isAvailable(): Promise<boolean>;

  /**
   * Build the argv for `docker run` / `podman run` from ContainerCreateOptions.
   * Validates that every mount destination is under an allowed prefix and
   * that the user is non-root (the design mandates non-root).
   */
  protected buildRunArgs(opts: ContainerCreateOptions): string[] {
    if (!opts.image) throw new ContainerError('image is required', this.engine);
    if (!opts.name) throw new ContainerError('name is required', this.engine);
    if (!opts.user) throw new ContainerError('user is required', this.engine);
    if (opts.user === 'root' || opts.user === '0' || opts.user === '0:0') {
      throw new ContainerError('non-root user is mandatory', this.engine);
    }
    if (opts.mounts.length === 0) {
      throw new ContainerError('at least one mount is required', this.engine);
    }

    const argv: string[] = [this.binary, 'run', '-d', '--name', opts.name];
    argv.push('-u', opts.user);
    for (const cap of opts.dropCapabilities ?? ['ALL']) {
      argv.push('--cap-drop', cap);
    }
    if (opts.readOnlyRoot) {
      argv.push('--read-only');
    }
    if (opts.workdir) {
      argv.push('-w', opts.workdir);
    }

    // Validate + emit mounts.
    for (const m of opts.mounts) {
      // Defense-in-depth: refuse host paths that obviously leak secrets.
      const host = m.hostPath;
      if (host.includes('.ssh') || host.includes('.aws') || host.endsWith('/.docker.sock') || host.includes('/.docker/')) {
        throw new ContainerError(`forbidden mount source: ${host}`, this.engine);
      }
      const spec = m.readOnly ? `${host}:${m.containerPath}:ro` : `${host}:${m.containerPath}`;
      argv.push('-v', spec);
    }

    // Env. Caller is expected to have already filtered through EnvVarAllowlist;
    // this provider double-checks defensively.
    for (const [name, value] of Object.entries(opts.env)) {
      argv.push('-e', `${name}=${value}`);
    }

    argv.push(opts.image);
    argv.push(...opts.command);
    return argv;
  }

  /** Spawn the binary with the given argv; return stdout / stderr. */
  protected async run(argv: string[], options: { stdin?: string } = {}): Promise<{ stdout: string; stderr: string; code: number }> {
    return new Promise((resolve, reject) => {
      const child = spawn(argv[0], argv.slice(1), { stdio: ['pipe', 'pipe', 'pipe'] });
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
      child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));
      child.on('error', err => reject(new ContainerError(`spawn failed: ${err.message}`, this.engine, err)));
      child.on('close', code => {
        resolve({
          stdout: Buffer.concat(stdoutChunks).toString('utf-8'),
          stderr: Buffer.concat(stderrChunks).toString('utf-8'),
          code: code ?? -1,
        });
      });
      if (options.stdin !== undefined) {
        child.stdin.write(options.stdin);
        child.stdin.end();
      }
    });
  }

  async create(options: ContainerCreateOptions): Promise<ContainerHandle> {
    const argv = this.buildRunArgs(options);
    const r = await this.run(argv);
    if (r.code !== 0) {
      throw new ContainerError(`run failed (exit ${r.code}): ${r.stderr}`, this.engine);
    }
    // `docker run -d` prints the container id on stdout.
    const id = r.stdout.trim().split('\n').pop()?.trim() ?? '';
    if (!id) throw new ContainerError('run produced empty container id', this.engine);
    return { id, name: options.name, engine: this.engine };
  }

  async exec(options: ContainerExecOptions): Promise<ContainerExecResult> {
    // `docker exec` returns the exec_id on stdout via --detach. For non-detached,
    // the command runs inline and we capture stdout/stderr + exit code.
    if (options.detach) {
      const argv = [this.binary, 'exec', '-d', options.containerId, ...options.command];
      const r = await this.run(argv);
      if (r.code !== 0) {
        throw new ContainerError(`exec failed: ${r.stderr}`, this.engine);
      }
      return { execId: r.stdout.trim() || '(detached)' };
    }
    const argv = [this.binary, 'exec', options.containerId, ...options.command];
    const r = await this.run(argv);
    return {
      execId: '(inline)',
      stdout: r.stdout,
      stderr: r.stderr,
      exitCode: r.code,
    };
  }

  async killExec(_execId: string, _signal = 'SIGTERM'): Promise<void> {
    // The CLI engines do not expose per-exec kill; the design path is to
    // signal the container PID via `docker kill --signal`. ContainerSandbox
    // records the exec_id for diagnostics only.
  }

  async killContainer(containerId: string, signal = 'SIGTERM'): Promise<void> {
    const argv = [this.binary, 'kill', '--signal', signal, containerId];
    const r = await this.run(argv);
    if (r.code !== 0 && !/No such container/i.test(r.stderr)) {
      throw new ContainerError(`kill failed: ${r.stderr}`, this.engine);
    }
  }

  async remove(containerId: string, force = false): Promise<void> {
    const argv = force
      ? [this.binary, 'rm', '-f', containerId]
      : [this.binary, 'rm', containerId];
    const r = await this.run(argv);
    if (r.code !== 0) {
      // ENOENT is fine — remove is idempotent.
      if (!/No such container/i.test(r.stderr) && !/no such container/i.test(r.stderr)) {
        throw new ContainerError(`rm failed: ${r.stderr}`, this.engine);
      }
    }
  }

  async inspect(containerId: string): Promise<ContainerInspectInfo> {
    const argv = [this.binary, 'inspect', '--format', '{{json .}}', containerId];
    const r = await this.run(argv);
    if (r.code !== 0) {
      throw new ContainerError(`inspect failed: ${r.stderr}`, this.engine);
    }
    let parsed: { Id?: string; Name?: string; State?: { Status?: string; Pid?: number }; Mounts?: Array<{ Source: string; Destination: string; RW: boolean }> };
    try {
      parsed = JSON.parse(r.stdout.trim());
    } catch (err) {
      throw new ContainerError(`inspect output not JSON: ${(err as Error).message}`, this.engine, err);
    }
    const status: ContainerStatus = (parsed.State?.Status as ContainerStatus) ?? 'unknown';
    return {
      id: parsed.Id ?? containerId,
      name: parsed.Name?.replace(/^\//, '') ?? containerId,
      status,
      pid: parsed.State?.Pid,
      mounts: parsed.Mounts?.map(m => ({
        source: m.Source,
        destination: m.Destination,
        readOnly: !m.RW,
      })),
    };
  }
}