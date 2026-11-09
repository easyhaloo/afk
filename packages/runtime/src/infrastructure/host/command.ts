import { spawn } from 'node:child_process';
import type { HostConnectionPort, HostExecResult, HostFailureCode } from '@afk/core';
import { HostFailure } from '@afk/core';
import { z } from 'zod';

export interface HostCommandOptions {
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface CancellableHostConnection extends HostConnectionPort {
  exec(host: string, argv: readonly string[], options?: HostCommandOptions): Promise<HostExecResult>;
  upload?(host: string, source: string, destination: string, options?: HostCommandOptions): Promise<void>;
}

export interface HostCommandResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export type HostCommandExecutor = (
  command: string,
  argv: readonly string[],
  options?: HostCommandOptions,
) => Promise<HostCommandResult>;

export function validateTimeout(timeoutMs = 30000): number {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2147483647) {
    throw new HostFailure('remote-failed', 'timeoutMs must be a positive finite duration below 2147483648ms');
  }
  return timeoutMs;
}

export function validateArgv(argv: readonly string[]): void {
  if (!argv.length || !argv[0] || argv.some(argument => typeof argument !== 'string' || argument.includes('\0'))) {
    throw new HostFailure('remote-failed', 'exec requires a non-empty command and NUL-free string arguments');
  }
}

export function validatePath(value: string): void {
  if (!value || /[\0\r\n]/.test(value)) throw new HostFailure('remote-failed', 'file path is empty or contains control characters');
}

export function createHostCommandExecutor(): HostCommandExecutor {
  return async (command, argv, options = {}) => {
    const timeoutMs = validateTimeout(options.timeoutMs);
    if (options.signal?.aborted) throw new HostFailure('unreachable', `${command} cancelled`);
    return new Promise((resolve, reject) => {
      const child = spawn(command, [...argv], {
        shell: false,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      let bytes = 0;
      let failure: HostFailure | undefined;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      const signalProcess = (signal: NodeJS.Signals) => {
        try {
          if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal);
          else child.kill(signal);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') child.kill(signal);
        }
      };
      const stop = (error: HostFailure) => {
        if (failure) return;
        failure = error;
        signalProcess('SIGTERM');
        killTimer = setTimeout(() => signalProcess('SIGKILL'), 100);
      };
      const onAbort = () => stop(new HostFailure('unreachable', `${command} cancelled`));
      const timer = setTimeout(() => stop(new HostFailure('unreachable', `${command} timed out after ${timeoutMs}ms`)), timeoutMs);
      options.signal?.addEventListener('abort', onAbort, { once: true });
      if (options.signal?.aborted) onAbort();
      const append = (chunk: string, stream: 'stdout' | 'stderr') => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > 8 * 1024 * 1024) {
          stop(new HostFailure('remote-failed', `${command} exceeded the 8MiB output limit`));
          return;
        }
        if (stream === 'stdout') stdout += chunk;
        else stderr += chunk;
      };
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', chunk => append(chunk, 'stdout'));
      child.stderr.on('data', chunk => append(chunk, 'stderr'));
      const cleanup = () => {
        clearTimeout(timer);
        if (killTimer) {
          signalProcess('SIGKILL');
          clearTimeout(killTimer);
          killTimer = undefined;
        }
        options.signal?.removeEventListener('abort', onAbort);
      };
      child.once('error', error => { cleanup(); reject(error); });
      child.once('close', (code, signal) => {
        cleanup();
        if (failure) reject(failure);
        else if (signal) reject(new HostFailure('unreachable', `${command} terminated by signal ${signal}`));
        else resolve({ code, stdout, stderr });
      });
    });
  };
}

export function classifyHostFailure(input: {
  readonly command?: string;
  readonly message?: string;
  readonly stderr?: string;
  readonly code?: number | null | string;
}): HostFailureCode {
  const text = `${input.message ?? ''} ${input.stderr ?? ''}`.toLowerCase();
  if (input.code === 'ENOENT' || /spawn .*enoent|not found on path/.test(text)) return 'binary-missing';
  if (/context .*not found|context .*does not exist|cluster .*not found|server [\w."'-]+ not found|unknown server|profile .*could not be found|error loading config file/.test(text)) return 'server-unknown';
  if (/credential|unauthori[sz]ed|accessdenied|access denied|permission denied|forbidden|not logged|expiredtoken|invalidclienttoken|authenticate/.test(text)) return 'auth-required';
  if (/invalidinstanceid|instance .*not found|(?:pods?|namespaces?|container) .*not found|no such pod|unknown asset|unknown host/.test(text)) return 'asset-unknown';
  if (/timed out|timeout|cancelled|aborted|connection refused|connection reset|connection closed|network|unreachable|econnrefused|etimedout|temporary failure|no route|dns|could not resolve hostname|could not connect to|unable to connect to the server/.test(text)) return 'unreachable';
  return 'remote-failed';
}

export function asHostFailure(input: Parameters<typeof classifyHostFailure>[0], fallback: string, cause?: unknown): HostFailure {
  return new HostFailure(classifyHostFailure(input), input.stderr?.trim() || input.message?.trim() || fallback, { cause });
}

export async function runHostCommand(
  exec: HostCommandExecutor,
  command: string,
  argv: readonly string[],
  options?: HostCommandOptions,
  classify?: (result: HostCommandResult) => HostFailureCode | null,
): Promise<HostCommandResult> {
  validateTimeout(options?.timeoutMs);
  if (options?.signal?.aborted) throw new HostFailure('unreachable', `${command} cancelled`);
  let result: HostCommandResult;
  try {
    result = await exec(command, argv, options);
  } catch (error) {
    if (error instanceof HostFailure) throw error;
    throw asHostFailure({
      message: error instanceof Error ? error.message : String(error),
      code: (error as NodeJS.ErrnoException | undefined)?.code,
    }, `${command} failed`, error);
  }
  if (options?.signal?.aborted) throw new HostFailure('unreachable', `${command} cancelled`);
  if (!result || (result.code !== null && (!Number.isInteger(result.code) || result.code < 0)) || typeof result.stdout !== 'string' || typeof result.stderr !== 'string') {
    throw new HostFailure('remote-failed', `${command} returned an invalid process result`);
  }
  if (result.code !== 0) {
    const code = result.code === null ? 'unreachable' : (classify ? classify(result) : classifyHostFailure(result));
    if (code === null) return result;
    throw new HostFailure(code, result.stderr.trim() || `${command} exited with ${result.code}`);
  }
  return result;
}

export function toHostExecResult(result: HostCommandResult): HostExecResult {
  if (result.code === null) throw new HostFailure('unreachable', 'command ended without an exit code');
  return { code: result.code, stdout: result.stdout, stderr: result.stderr };
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function parseJson<T>(text: string, context: string, schema: z.ZodType<T>): T {
  try {
    return schema.parse(JSON.parse(text));
  } catch (error) {
    throw new HostFailure('remote-failed', `${context} returned invalid JSON or response data`, { cause: error });
  }
}
