import { execFile } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import type {
  ProviderOperationOptions,
  VerificationCapability,
  VerificationProvider,
  VerificationRequest,
  VerificationResult,
} from '../../plugin-sdk/capabilities.js';

export interface VerificationCommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface VerificationCommandOptions extends ProviderOperationOptions {
  readonly cwd: string;
  readonly timeoutMs: number;
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
  const controller = new AbortController();
  const abort = (): void => controller.abort(options.signal?.reason);
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) abort();
  return new Promise<VerificationCommandResult>((resolve, reject) => {
    execFile(argv[0], [...argv.slice(1)], {
      cwd: options.cwd,
      timeout: options.timeoutMs,
      signal: controller.signal,
      killSignal: 'SIGKILL',
      maxBuffer: 4 * 1024 * 1024,
      encoding: 'utf8',
      shell: false,
    }, (error, stdout, stderr) => {
      options.signal?.removeEventListener('abort', abort);
      if (controller.signal.aborted) return reject(controller.signal.reason ?? error);
      if (error && typeof error.code !== 'number') {
        if (error.killed || error.signal) {
          resolve({ exitCode: 1, stdout, stderr: [stderr, `verification terminated: ${error.signal ?? 'timeout'}`].filter(Boolean).join('\n') });
        } else reject(error);
      } else resolve({ exitCode: typeof error?.code === 'number' ? error.code : 0, stdout, stderr });
    });
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
    const command = request.command ?? this.command;
    const timeoutMs = request.timeoutMs ?? this.timeoutMs;
    validateCommand(command);
    validateTimeout(timeoutMs);
    if (options.signal?.aborted) throw options.signal.reason ?? new Error('verification aborted');
    const startedAt = performance.now();
    const result = await this.runner(command, { ...options, cwd: request.target, timeoutMs });
    if (options.signal?.aborted) throw options.signal.reason ?? new Error('verification aborted');
    return {
      passed: result.exitCode === 0,
      durationMs: Math.max(0, performance.now() - startedAt),
      output: [result.stdout, result.stderr].filter(Boolean).join('\n'),
    };
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
