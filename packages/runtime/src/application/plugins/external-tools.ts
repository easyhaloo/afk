import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, mkdtemp, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { validateManifest, type ExternalToolDependency, type PluginManifest } from '../../plugin-sdk/profile.js';

export interface VersionProbeRequest {
  readonly command: string;
  readonly args: readonly string[];
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly cleanupTimeoutMs: number;
}

export type VersionProbeExecutor = (request: VersionProbeRequest) => Promise<{ readonly stdout: string; readonly stderr: string }>;

export interface ExternalToolDiagnostic {
  readonly id: string;
  readonly location: 'host' | 'backend';
  readonly status: 'available' | 'missing' | 'unsupported' | 'outdated' | 'unknown';
  readonly version?: string;
  readonly cleanup?: 'unconfirmed';
  readonly reason?: 'not-requested' | 'not-approved' | 'backend-required' | 'executor-untrusted' | 'no-version-probe' | 'probe-failed' | 'unrecognized-version' | 'output-limit' | 'timeout' | 'cancelled';
}

export interface ExternalToolDiagnosticOptions {
  readonly probe?: boolean;
  readonly approvedProbes?: readonly { readonly command: string; readonly args: readonly string[]; readonly location: 'host' | 'backend' }[];
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly execute?: VersionProbeExecutor;
  readonly executorLifecycle?: 'trusted-cooperative';
  readonly backend?: { readonly platform: string; readonly architecture: string; readonly execute: VersionProbeExecutor; readonly lifecycle?: 'trusted-cooperative' };
}

export function listExternalTools(manifest: PluginManifest): readonly ExternalToolDependency[] {
  validateManifest(manifest);
  return manifest.externalTools ?? [];
}

const executeVersionProbe: VersionProbeExecutor = async request => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'afk-tool-version-')));
  let started = false;
  try {
    request.signal.throwIfAborted();
    return await new Promise((resolve, reject) => {
      let failure: unknown;
      let output = { stdout: '', stderr: '' };
      let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
      let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
      let bytes = 0;
      const child = execFile(request.command, [...request.args], {
        cwd: directory,
        env: {
          PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
          HOME: directory, USERPROFILE: directory, XDG_CONFIG_HOME: directory, XDG_CACHE_HOME: directory,
          TMPDIR: directory, TEMP: directory, TMP: directory,
        },
        shell: false, encoding: 'utf8', windowsHide: true,
        killSignal: 'SIGKILL', maxBuffer: request.maxOutputBytes,
      }, (error, stdout, stderr) => {
        failure ??= error;
        output = { stdout, stderr };
      });
      started = true;
      const cleanupFailure = () => reject(Object.assign(new Error('Probe cleanup was not confirmed'), { code: 'PROBE_CLEANUP_UNCONFIRMED' }));
      const stop = (error: unknown) => {
        failure ??= error;
        if (cleanupTimer) return;
        cleanupTimer = setTimeout(cleanupFailure, request.cleanupTimeoutMs);
        child.kill('SIGKILL');
      };
      const abort = () => stop(request.signal.reason);
      request.signal.addEventListener('abort', abort, { once: true });
      timeoutTimer = setTimeout(() => stop(new Error('Probe timed out')), request.timeoutMs);
      const collect = (chunk: string) => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > request.maxOutputBytes) stop(Object.assign(new Error('Probe output exceeded limit'), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }));
      };
      child.stdout?.on('data', collect);
      child.stderr?.on('data', collect);
      child.once('close', async () => {
        clearTimeout(timeoutTimer);
        request.signal.removeEventListener('abort', abort);
        cleanupTimer ??= setTimeout(cleanupFailure, request.cleanupTimeoutMs);
        try {
          await rm(directory, { recursive: true, force: true });
          if (failure) reject(failure);
          else resolve(output);
        } catch { cleanupFailure(); }
        finally { clearTimeout(cleanupTimer); }
      });
      if (request.signal.aborted) abort();
    });
  } finally {
    if (!started) await rm(directory, { recursive: true, force: true });
  }
};

async function locateHostTool(command: string, signal: AbortSignal): Promise<{ stdout: string; stderr: string }> {
  const directories = (process.env.PATH ?? '').split(delimiter).filter(Boolean);
  if (directories.length > 128) throw new Error('Tool search path exceeds limit');
  const extensions = process.platform === 'win32' ? ['', '.exe', '.com', '.cmd', '.bat'] : [''];
  for (const directory of directories) {
    for (const extension of extensions) {
      signal.throwIfAborted();
      const path = join(directory, command + extension);
      try {
        if (!(await stat(path)).isFile()) continue;
        await access(path, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
        return { stdout: '', stderr: '' };
      } catch (error) {
        if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      }
    }
  }
  throw Object.assign(new Error('Tool not found'), { code: 'ENOENT' });
}

export async function diagnoseExternalTools(manifest: PluginManifest, options: ExternalToolDiagnosticOptions = {}): Promise<readonly ExternalToolDiagnostic[]> {
  const tools = listExternalTools(manifest);
  const timeoutMs = options.timeoutMs ?? 3000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 5000) throw new Error('Invalid external tool timeout');
  const deadline = Date.now() + timeoutMs;
  const results: ExternalToolDiagnostic[] = [];
  for (const tool of tools) {
    const base = { id: tool.id, location: tool.location };
    const unknown = (reason: ExternalToolDiagnostic['reason']): ExternalToolDiagnostic => ({ ...base, status: 'unknown', reason });
    const target = tool.location === 'backend' ? options.backend : {
      platform: process.platform, architecture: process.arch, execute: options.execute ?? executeVersionProbe,
      lifecycle: options.executorLifecycle,
    };
    const owned = tool.location === 'host' && !options.execute;
    if (options.probe !== true) { results.push(unknown('not-requested')); continue; }
    if (!target) { results.push(unknown('backend-required')); continue; }
    if ((tool.platforms && !tool.platforms.some(platform => platform === target.platform))
      || (tool.architectures && !tool.architectures.some(architecture => architecture === target.architecture))) {
      results.push({ ...base, status: 'unsupported' });
      continue;
    }
    if (!tool.version && tool.location === 'backend') { results.push(unknown('no-version-probe')); continue; }
    const args = tool.version?.args;
    if (args && !options.approvedProbes?.some(probe => probe.command === tool.command && probe.location === tool.location
      && probe.args.length === args.length && probe.args.every((arg, index) => arg === args[index]))) {
      results.push(unknown('not-approved'));
      continue;
    }
    if (options.signal?.aborted) { results.push(unknown('cancelled')); continue; }
    if (args && !owned && target.lifecycle !== 'trusted-cooperative') { results.push(unknown('executor-untrusted')); continue; }
    const remaining = deadline - Date.now();
    if (remaining <= 0) { results.push(unknown('timeout')); continue; }
    const controller = new AbortController();
    const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
    const timer = setTimeout(() => controller.abort(), remaining);
    const cleanupTimeoutMs = 1000;
    let onAbort: () => void = () => undefined;
    const interrupted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(signal.reason);
      signal.addEventListener('abort', onAbort, { once: true });
    });
    void interrupted.catch(() => undefined);
    let settled = false;
    let execution: Promise<{ readonly stdout: string; readonly stderr: string }> | undefined;
    try {
      execution = Promise.resolve().then(() => {
        signal.throwIfAborted();
        return args ? target.execute({ command: tool.command, args: [...args], signal, timeoutMs: remaining, maxOutputBytes: 4096, cleanupTimeoutMs }) : locateHostTool(tool.command, signal);
      });
      void execution.then(() => { settled = true; }, () => { settled = true; });
      const output = await (owned && args ? execution : Promise.race([execution, interrupted]));
      if (signal.aborted) throw signal.reason;
      if (!tool.version) { results.push(unknown('no-version-probe')); continue; }
      if (Buffer.byteLength(output.stdout) + Buffer.byteLength(output.stderr) > 4096) {
        results.push(unknown('output-limit'));
        continue;
      }
      const candidate = `${output.stdout}\n${output.stderr}`.match(/\d+(?:\.\d+)+(?:[A-Za-z-][A-Za-z0-9.-]*)?/)?.[0];
      if (!candidate || !/^(?:0|[1-9]\d{0,5})\.(?:0|[1-9]\d{0,5})(?:\.(?:0|[1-9]\d{0,5}))?$/.test(candidate)) {
        results.push(unknown('unrecognized-version'));
        continue;
      }
      const actual = candidate.split('.').map(Number);
      const minimum = tool.version.minimum?.split('.').map(Number);
      const difference = minimum?.map((part, index) => (actual[index] ?? 0) - part).find(value => value !== 0) ?? 0;
      results.push({ ...base, status: difference < 0 ? 'outdated' : 'available', version: candidate });
    } catch (error) {
      let cleanupUnconfirmed = (error as NodeJS.ErrnoException | undefined)?.code === 'PROBE_CLEANUP_UNCONFIRMED';
      if (signal.aborted && !owned && args && execution) {
        let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            execution.then(() => undefined, failure => {
              cleanupUnconfirmed ||= (failure as NodeJS.ErrnoException | undefined)?.code === 'PROBE_CLEANUP_UNCONFIRMED';
            }),
            new Promise<void>(resolve => { cleanupTimer = setTimeout(resolve, cleanupTimeoutMs); }),
          ]);
          cleanupUnconfirmed ||= !settled;
        } finally { clearTimeout(cleanupTimer); }
      }
      if (signal.aborted || cleanupUnconfirmed) results.push({
        ...unknown(signal.aborted ? options.signal?.aborted ? 'cancelled' : 'timeout' : 'probe-failed'),
        ...(cleanupUnconfirmed ? { cleanup: 'unconfirmed' as const } : {}),
      });
      else if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') results.push({ ...base, status: 'missing' });
      else results.push(unknown((error as NodeJS.ErrnoException | undefined)?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ? 'output-limit' : 'probe-failed'));
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    }
  }
  return results;
}
