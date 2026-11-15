import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import type {
  ProviderOperationOptions,
  VerificationCapability,
  VerificationExecutionObservation,
  VerificationProvider,
  VerificationRequest,
  VerificationResult,
} from '../../plugin-sdk/capabilities.js';

export interface VerificationCommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly execution?: VerificationExecutionObservation;
}

export interface VerificationCommandOptions extends ProviderOperationOptions {
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly input?: string;
  readonly executionId?: string;
}

export type VerificationCommandRunner = (
  argv: readonly string[],
  options: VerificationCommandOptions,
) => Promise<VerificationCommandResult>;

export interface CommandVerificationOptions {
  readonly command?: readonly string[];
  readonly timeoutMs?: number;
  readonly runner?: VerificationCommandRunner;
}

export const runVerificationCommand: VerificationCommandRunner = (argv, options) => {
  validateCommand(argv);
  validateTimeout(options.timeoutMs);
  validateInput(options.input, options.executionId);
  if (options.signal?.aborted) return Promise.reject(options.signal.reason ?? new Error('verification aborted'));
  const command = [...argv];
  const input = options.input;
  const executionId = options.executionId;
  const cwd = executionId === undefined ? options.cwd : realpathSync(options.cwd);
  const timeoutMs = remainingTimeout(options.timeoutMs, options.deadlineAt);
  return new Promise<VerificationCommandResult>((resolve, reject) => {
    let outcome: (() => void) | undefined;
    let inputFailed = false;
    let exitCode: number | null = null;
    let exitSignal: string | null = null;
    const abort = (): void => { child.kill('SIGKILL'); };
    const child = execFile(command[0], command.slice(1), {
      cwd,
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
      maxBuffer: 4 * 1024 * 1024,
      encoding: 'utf8',
      shell: false,
    }, (error, stdout, stderr) => {
      outcome = () => {
        if (options.signal?.aborted) return reject(options.signal.reason ?? new Error('verification aborted'));
        if (options.deadlineAt !== undefined && Date.now() >= options.deadlineAt) return reject(new Error('verification deadline exceeded'));
        if (inputFailed) return reject(new Error('verification input failed'));
        if (error && typeof error.code !== 'number') {
          if (error.killed || error.signal) {
            resolve({ exitCode: 1, stdout, stderr: [stderr, `verification terminated: ${error.signal ?? 'timeout'}`].filter(Boolean).join('\n') });
          } else reject(error);
        } else {
          const execution: VerificationExecutionObservation | undefined = executionId !== undefined
            && exitSignal === null && exitCode !== null && Number.isSafeInteger(exitCode)
            && exitCode === (typeof error?.code === 'number' ? error.code : 0)
            ? { protocol: 'verification-execution-v1', executionId, command, cwd,
              inputDigest: createHash('sha256').update(input ?? '').digest('hex'), exitCode, stdout, stderr, closed: true }
            : undefined;
          resolve({ exitCode: typeof error?.code === 'number' ? error.code : 0, stdout, stderr, ...(execution ? { execution } : {}) });
        }
      };
    });
    child.once('close', (code, signal) => {
      exitCode = code;
      exitSignal = signal;
      options.signal?.removeEventListener('abort', abort);
      outcome?.();
    });
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    if (input !== undefined) {
      if (!child.stdin) inputFailed = true;
      else {
        child.stdin.on('error', () => { inputFailed = true; });
        child.stdin.end(input);
      }
    }
  });
};

export class CommandVerificationProvider implements VerificationProvider {
  readonly capabilities: Readonly<Record<VerificationCapability, boolean>>;
  private readonly command: readonly string[];
  private readonly timeoutMs: number;
  private readonly runner: VerificationCommandRunner;

  constructor(
    readonly id: string,
    capability: 'static-analysis' | 'test-execution',
    defaultCommand: readonly string[],
    options: CommandVerificationOptions = {},
  ) {
    this.capabilities = {
      'static-analysis': capability === 'static-analysis',
      'test-execution': capability === 'test-execution',
      'custom-script': true,
    };
    this.command = options.command ?? defaultCommand;
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.runner = options.runner ?? runVerificationCommand;
    validateCommand(this.command);
    validateTimeout(this.timeoutMs);
  }

  async verify(request: VerificationRequest, options: ProviderOperationOptions = {}): Promise<VerificationResult> {
    if (!request.target?.trim() || request.target.includes('\0')) throw new Error('verification target must be a workspace directory');
    const selectedCommand = request.command ?? this.command;
    validateCommand(selectedCommand);
    const command = [...selectedCommand];
    const timeoutMs = request.timeoutMs ?? this.timeoutMs;
    const input = request.input;
    const executionId = request.executionId;
    validateCommand(command);
    validateTimeout(timeoutMs);
    validateInput(input, executionId);
    if (options.signal?.aborted) throw options.signal.reason ?? new Error('verification aborted');
    const remainingMs = remainingTimeout(timeoutMs, options.deadlineAt);
    const startedAt = performance.now();
    const result = await this.runner(command, { ...options, cwd: request.target, timeoutMs: remainingMs,
      ...(input !== undefined ? { input } : {}), ...(executionId !== undefined ? { executionId } : {}) });
    if (options.signal?.aborted) throw options.signal.reason ?? new Error('verification aborted');
    if (options.deadlineAt !== undefined && Date.now() >= options.deadlineAt) throw new Error('verification deadline exceeded');
    return {
      passed: result.exitCode === 0,
      durationMs: Math.max(0, performance.now() - startedAt),
      output: [result.stdout, result.stderr].filter(Boolean).join('\n'),
      ...(executionId !== undefined && this.runner === runVerificationCommand && result.execution ? { execution: result.execution } : {}),
    };
  }
}

function remainingTimeout(timeoutMs: number, deadlineAt: number | undefined): number {
  if (deadlineAt === undefined) return timeoutMs;
  if (!Number.isSafeInteger(deadlineAt) || deadlineAt <= Date.now()) throw new Error('verification deadline exceeded');
  return Math.max(1, Math.min(timeoutMs, deadlineAt - Date.now()));
}

function validateInput(input: string | undefined, executionId: string | undefined): void {
  if (input !== undefined && (typeof input !== 'string' || Buffer.byteLength(input, 'utf8') > 256 * 1024)) {
    throw new Error('verification input must be a string of at most 256 KiB');
  }
  if (executionId !== undefined && (typeof executionId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/.test(executionId))) {
    throw new Error('verification executionId must be a bounded identifier');
  }
}

function validateCommand(command: readonly string[]): void {
  if (!Array.isArray(command) || !command.length || !command[0]?.trim() || command.some(argument => typeof argument !== 'string' || argument.includes('\0'))) {
    throw new Error('verification command must be a non-empty argv array');
  }
}

function validateTimeout(timeoutMs: number): void {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
    throw new Error('verification timeoutMs must be a positive 32-bit integer');
  }
}
