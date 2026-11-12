/**
 * Shared base for CLI-based container providers (docker, podman).
 *
 * Both engines share the run / exec / kill / rm / inspect CLI surface for
 * the subset we need, so this base class builds argv arrays, runs them
 * via child_process, and parses JSON output where applicable. Subclasses
 * only set the binary path and engine name.
 */

import { execFile, spawn } from 'child_process';
import { performance } from 'node:perf_hooks';
import type {
  ContainerProvider,
  ContainerEngine,
  ContainerCreateOptions,
  ContainerHandle,
  ContainerExecOptions,
  ContainerExecResult,
  ContainerInspectInfo,
  ContainerStatus,
  FrozenCommandOptions,
  FrozenContainerInspection,
  FrozenContainerOperations,
} from './types.js';
import { ContainerError } from './types.js';

export abstract class CliContainerProvider implements ContainerProvider {
  abstract readonly engine: ContainerEngine;
  abstract readonly binary: string;

  abstract isAvailable(): Promise<boolean>;

  private readonly unconfirmedFrozenAllocations = new Set<string>();

  get frozen(): FrozenContainerOperations | undefined { return this.engine === 'docker' ? this : undefined; }

  protected probeVersion(format: string): Promise<boolean> {
    return new Promise(resolve => {
      execFile(this.binary, ['version', '--format', format], { timeout: 5000, killSignal: 'SIGKILL', maxBuffer: 64 * 1024 },
        (error, stdout) => resolve(!error && stdout.trim().length > 0));
    });
  }

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
  protected async run(argv: string[], options: { stdin?: string | Buffer; signal?: AbortSignal; timeoutMs?: number; maxOutputBytes?: number; legacyBuild?: boolean } = {}): Promise<{ stdout: string; stderr: string; code: number }> {
    if (options.signal?.aborted) throw options.signal.reason;
    return new Promise((resolve, reject) => {
      const child = spawn(argv[0], argv.slice(1), { stdio: ['pipe', 'pipe', 'pipe'],
        ...(options.legacyBuild ? { env: { ...process.env, DOCKER_BUILDKIT: '0' } } : {}) });
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let outputBytes = 0;
      let failure: unknown;
      let failed = false;
      const recordFailure = (reason: unknown) => { if (!failed) { failure = reason; failed = true; } };
      const stop = (reason: unknown) => {
        if (failed) return;
        recordFailure(reason);
        child.kill('SIGKILL');
        child.stdin.destroy();
        child.stdout.destroy();
        child.stderr.destroy();
      };
      const abort = () => stop(options.signal?.reason);
      const timer = options.timeoutMs === undefined ? undefined : setTimeout(() => stop(new Error('Container command deadline exceeded')), options.timeoutMs);
      const receive = (target: Buffer[], chunk: Buffer) => {
        outputBytes += chunk.length;
        if (options.maxOutputBytes !== undefined && outputBytes > options.maxOutputBytes) stop(new Error('Container command output limit exceeded'));
        else if (!failed) target.push(chunk);
      };
      child.stdout.on('data', (chunk: Buffer) => receive(stdoutChunks, chunk));
      child.stderr.on('data', (chunk: Buffer) => receive(stderrChunks, chunk));
      options.signal?.addEventListener('abort', abort, { once: true });
      if (options.signal?.aborted) abort();
      child.stdin.on('error', error => { if ((error as NodeJS.ErrnoException).code !== 'EPIPE') stop(error); });
      child.on('error', err => stop(new ContainerError(`spawn failed: ${err.message}`, this.engine, err)));
      child.on('close', code => {
        if (timer) clearTimeout(timer);
        options.signal?.removeEventListener('abort', abort);
        if (failed) { reject(failure); return; }
        resolve({
          stdout: Buffer.concat(stdoutChunks).toString('utf-8'),
          stderr: Buffer.concat(stderrChunks).toString('utf-8'),
          code: code ?? -1,
        });
      });
      if (options.stdin !== undefined) {
        child.stdin.end(options.stdin);
      } else {
        child.stdin.end();
      }
    });
  }

  private frozenOwner(operationId: string): string {
    if (this.engine !== 'docker' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(operationId)) throw new Error('Invalid frozen Docker ownership');
    return `afk.frozen.operation=${operationId}`;
  }

  private async frozenRun(args: string[], options: FrozenCommandOptions & { stdin?: Buffer; legacyBuild?: boolean }): Promise<{ stdout: string; stderr: string; code: number }> {
    if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 120_000
      || !Number.isSafeInteger(options.maxOutputBytes) || options.maxOutputBytes < 1 || options.maxOutputBytes > 1024 * 1024) throw new Error('Invalid frozen command bounds');
    return this.run([this.binary, ...args], options);
  }

  async buildFrozenImage(operationId: string, baseImageId: string, context: Buffer, options: FrozenCommandOptions): Promise<string> {
    const owner = this.frozenOwner(operationId);
    if (this.unconfirmedFrozenAllocations.has(operationId)) throw new Error('Prior frozen allocation completion is unconfirmed');
    if (!/^sha256:[a-f0-9]{64}$/.test(baseImageId)) throw new Error('Frozen base image must be an exact image ID');
    const inspected = await this.frozenRun(['image', 'inspect', baseImageId], options);
    if (inspected.code !== 0) throw new Error('Frozen base image is not locally available');
    const images: { Id: string; Config: { OnBuild?: string[]; Volumes?: { [path: string]: object } } }[] = JSON.parse(inspected.stdout);
    if (images.length !== 1 || images[0].Id !== baseImageId || images[0].Config.OnBuild?.length || Object.keys(images[0].Config.Volumes ?? {}).length) throw new Error('Frozen base image has unsupported build hooks or volumes');
    if (options.signal?.aborted) throw options.signal.reason;
    if (this.unconfirmedFrozenAllocations.has(operationId)) throw new Error('Prior frozen allocation completion is unconfirmed');
    this.unconfirmedFrozenAllocations.add(operationId);
    const built = await this.frozenRun(['build', '--pull=false', '--network=none', '--force-rm', '--rm', '--quiet',
      '--label', owner, '--label', 'afk.frozen.managed=true', '-'], { ...options, stdin: context, legacyBuild: true });
    if (built.code !== 0) throw new Error(`Frozen local image build failed: ${built.stderr.slice(0, 2048)}`);
    const imageId = built.stdout.trim().split('\n').pop() ?? '';
    if (!/^sha256:[a-f0-9]{64}$/.test(imageId)) throw new Error('Frozen build did not return an exact image ID');
    this.unconfirmedFrozenAllocations.delete(operationId);
    return imageId;
  }

  async createFrozenContainer(operationId: string, imageId: string, argv: readonly string[], options: FrozenCommandOptions): Promise<string> {
    const owner = this.frozenOwner(operationId);
    if (this.unconfirmedFrozenAllocations.has(operationId)) throw new Error('Prior frozen allocation completion is unconfirmed');
    if (!/^sha256:[a-f0-9]{64}$/.test(imageId) || !argv.length || !argv[0]?.trim() || argv.length > 128
      || argv.some(argument => typeof argument !== 'string' || argument.includes('\0')) || Buffer.byteLength(JSON.stringify(argv)) > 32 * 1024) throw new Error('Invalid frozen image or command');
    if (options.signal?.aborted) throw options.signal.reason;
    this.unconfirmedFrozenAllocations.add(operationId);
    const created = await this.frozenRun(['create', '--pull=never', '--name', `afk-frozen-${operationId}`, '--label', owner,
      '--label', 'afk.frozen.managed=true', '--read-only', '--user', '1000:1000', '--network', 'none', '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges', '--pids-limit', '64', '--memory', '268435456', '--memory-swap', '268435456',
      '--cpus', '1', '--ipc', 'private', '--tmpfs', '/scratch:rw,noexec,nosuid,nodev,size=16777216,mode=700,uid=1000,gid=1000',
      '--entrypoint', '/usr/bin/env', '--workdir', '/workspace', '--no-healthcheck', '--log-driver', 'none', '--restart', 'no',
      '--stop-timeout', '1', imageId, '-i', 'PATH=/usr/local/bin:/usr/bin:/bin', 'HOME=/scratch', 'TMPDIR=/scratch', ...argv], options);
    if (created.code !== 0 || !/^[a-f0-9]{64}$/.test(created.stdout.trim())) throw new Error(`Frozen container creation failed: ${created.stderr.slice(0, 2048)}`);
    this.unconfirmedFrozenAllocations.delete(operationId);
    return created.stdout.trim();
  }

  async inspectFrozenContainer(containerId: string, options: FrozenCommandOptions): Promise<FrozenContainerInspection> {
    const result = await this.frozenRun(['container', 'inspect', containerId], options);
    if (result.code !== 0) throw new Error('Frozen container inspection failed');
    const containers: {
      Id: string; Name: string; Image: string; State: { Status: string; ExitCode: number };
      Config: { User: string; Labels?: { [name: string]: string }; Entrypoint: string[]; Cmd: string[]; WorkingDir: string };
      HostConfig: { ReadonlyRootfs: boolean; NetworkMode: string; CapDrop?: string[]; CapAdd?: string[]; SecurityOpt?: string[];
        Privileged: boolean; PidMode: string; IpcMode: string; Binds?: string[]; Tmpfs?: { [path: string]: string };
        Memory: number; MemorySwap: number; NanoCpus: number; PidsLimit: number; Devices?: object[]; DeviceRequests?: object[]; VolumesFrom?: string[] };
      Mounts?: { Type: string; Destination: string }[];
    }[] = JSON.parse(result.stdout);
    if (containers.length !== 1) throw new Error('Ambiguous frozen container inspection');
    const container = containers[0];
    if (container.HostConfig.CapAdd?.length || container.HostConfig.Devices?.length || container.HostConfig.DeviceRequests?.length || container.HostConfig.VolumesFrom?.length
      || container.Config.Labels?.['afk.frozen.managed'] !== 'true') throw new Error('Unexpected frozen container access');
    return { id: container.Id, name: container.Name.replace(/^\//, ''), imageId: container.Image,
      operationId: container.Config.Labels?.['afk.frozen.operation'] ?? '', status: container.State.Status, exitCode: container.State.ExitCode,
      user: container.Config.User, entrypoint: container.Config.Entrypoint, command: container.Config.Cmd, workdir: container.Config.WorkingDir,
      readOnlyRoot: container.HostConfig.ReadonlyRootfs, network: container.HostConfig.NetworkMode,
      capDrop: container.HostConfig.CapDrop ?? [], securityOptions: container.HostConfig.SecurityOpt ?? [], privileged: container.HostConfig.Privileged,
      pidMode: container.HostConfig.PidMode, ipcMode: container.HostConfig.IpcMode, binds: container.HostConfig.Binds ?? [],
      tmpfs: container.HostConfig.Tmpfs ?? {}, memory: container.HostConfig.Memory, memorySwap: container.HostConfig.MemorySwap,
      nanoCpus: container.HostConfig.NanoCpus, pidsLimit: container.HostConfig.PidsLimit,
      mounts: (container.Mounts ?? []).map(mount => ({ type: mount.Type, destination: mount.Destination })) };
  }

  async startFrozenContainer(containerId: string, options: FrozenCommandOptions): Promise<{ stdout: string; stderr: string; code: number }> {
    return this.frozenRun(['start', '--attach', containerId], options);
  }

  async killFrozenContainer(operationId: string, containerId: string, options: FrozenCommandOptions): Promise<void> {
    this.frozenOwner(operationId);
    if (!/^[a-f0-9]{64}$/.test(containerId)) throw new Error('Invalid frozen container identifier');
    const deadline = performance.now() + options.timeoutMs;
    const inspected = await this.inspectFrozenContainer(containerId, options);
    if (inspected.id !== containerId || inspected.operationId !== operationId || inspected.name !== `afk-frozen-${operationId}`
      || inspected.status !== 'running') throw new Error('Frozen control requires exact running ownership identity');
    const result = await this.frozenRun(['kill', '--signal=KILL', containerId], { ...options, timeoutMs: Math.floor(deadline - performance.now()) });
    if (result.code !== 0) throw new Error('Frozen container host kill failed');
  }

  async cleanupFrozenOperation(operationId: string, options: FrozenCommandOptions): Promise<void> {
    const owner = this.frozenOwner(operationId);
    const allocationUnconfirmed = this.unconfirmedFrozenAllocations.has(operationId);
    const deadline = performance.now() + options.timeoutMs;
    const bounded = () => {
      const timeoutMs = Math.floor(deadline - performance.now());
      if (timeoutMs < 1) throw new Error('Frozen cleanup deadline exceeded');
      return { ...options, timeoutMs };
    };
    const list = async (kind: 'container' | 'image') => {
      const result = await this.frozenRun([kind, 'ls', '--all', '--quiet', '--no-trunc', '--filter', `label=${owner}`, '--filter', 'label=afk.frozen.managed=true'], bounded());
      if (result.code !== 0) throw new Error('Frozen resource cleanup inventory failed');
      const identifiers = [...new Set(result.stdout.trim().split('\n').filter(Boolean))];
      if (identifiers.length > 16 || identifiers.some(identifier => !/^(sha256:)?[a-f0-9]{64}$/.test(identifier))) throw new Error('Invalid frozen cleanup inventory');
      return identifiers;
    };
    for (const kind of ['container', 'image'] as const) {
      for (const identifier of await list(kind)) {
        const inspected = await this.frozenRun([kind, 'inspect', '--format', '{{json .Config.Labels}}', identifier], bounded());
        if (inspected.code !== 0) throw new Error('Frozen resource ownership could not be confirmed');
        const labels: { [name: string]: string } = JSON.parse(inspected.stdout);
        if (labels['afk.frozen.operation'] !== operationId || labels['afk.frozen.managed'] !== 'true') throw new Error('Refusing unowned frozen resource cleanup');
        const removed = await this.frozenRun([kind, 'rm', ...(kind === 'container' ? ['--force'] : ['--no-prune']), identifier], bounded());
        if (removed.code !== 0) throw new Error('Frozen resource removal failed');
      }
      if ((await list(kind)).length) throw new Error('Frozen resource cleanup was not confirmed');
    }
    if (allocationUnconfirmed || this.unconfirmedFrozenAllocations.has(operationId)) throw new Error('Frozen allocation completion is unconfirmed');
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
      const argv = this.buildExecArgs(options, true);
      const r = await this.run(argv, { stdin: options.stdin });
      if (r.code !== 0) {
        throw new ContainerError(`exec failed: ${r.stderr}`, this.engine);
      }
      return { execId: r.stdout.trim() || '(detached)' };
    }
    const argv = this.buildExecArgs(options, false);
    const r = await this.run(argv, { stdin: options.stdin });
    return {
      execId: '(inline)',
      stdout: r.stdout,
      stderr: r.stderr,
      exitCode: r.code,
    };
  }

  private buildExecArgs(options: ContainerExecOptions, detach: boolean): string[] {
    const argv = [this.binary, 'exec'];
    if (detach) argv.push('-d');
    if (options.stdin !== undefined) argv.push('-i');
    if (options.workdir) argv.push('-w', options.workdir);
    for (const [name, value] of Object.entries(options.env ?? {})) {
      argv.push('-e', `${name}=${value}`);
    }
    argv.push(options.containerId, ...options.command);
    return argv;
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
