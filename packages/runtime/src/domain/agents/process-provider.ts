import type {
  AgentCommand,
  AgentCommandOptions,
  AgentEvent,
  AgentExecutionMetadata,
  AgentExecutionOptions,
  AgentPromptLimits,
  AgentProvider,
  AgentExecution,
  CaptureSessionOptions,
  RestoreSessionOptions,
  SessionSnapshot,
  NativeSessionCheckpoint,
  TokenUsage,
} from './types.js';
import { isAbsolute, resolve } from 'node:path';
import { measurePromptBudget, PromptBudgetExceededError } from './prompt-budget.js';

/** Shared execution boundary for command-based agent providers. */
export abstract class ProcessAgentProvider implements AgentProvider {
  abstract readonly name: AgentProvider['name'];
  abstract readonly capabilities: AgentProvider['capabilities'];

  /**
   * The limits this provider declares.
   *
   * A provider that knows its own limits declares them here; one that does
   * not is measured against the strictest limit AFK knows of.
   */
  readonly promptLimits?: AgentPromptLimits;
  protected readonly nativeSessions: boolean = false;

  abstract buildCommand(options: AgentCommandOptions): AgentCommand;
  parseLine?(line: string): AgentEvent[];

  async createExecution(options: AgentExecutionOptions): Promise<AgentExecution> {
    this.assertExecutionProfile(options);
    // A goal the provider would refuse is refused here, where the reason is
    // still known. Dispatching it would cost the whole idle timeout and
    // produce a timeout instead of a cause.
    const budget = measurePromptBudget({ prompt: options.prompt, limits: this.promptLimits });
    if (budget.exceeded) throw new PromptBudgetExceededError(budget);
    const executionMode = options.executionMode ?? (options.interactive ? 'interactive' : 'batch');
    const commandOptions = { ...options, executionMode, interactive: executionMode === 'interactive', goal: options.prompt };
    if (options.resume) {
      if (!this.nativeSessions) throw new Error(`${this.name} does not support explicit native resume`);
      await this.restoreSession({ snapshot: options.resume, worktreePath: options.worktreePath });
      if (!Number.isSafeInteger(options.generation) || options.generation !== options.resume.generation + 1) {
        throw new Error('Resume generation must follow the captured generation');
      }
    }
    if (options.sandbox.startProviderExecution) {
      const { sandbox, ...remoteOptions } = options;
      return options.sandbox.startProviderExecution(this.name, { ...remoteOptions, executionMode });
    }
    const worktreePath = options.sandbox.worktreePath ?? options.worktreePath;
    const workspacePath = options.sandbox.workspacePath ?? options.worktreePath;
    if (!isAbsolute(workspacePath) || (resolve(options.worktreePath) !== resolve(worktreePath)
      && resolve(options.worktreePath) !== resolve(workspacePath))) {
      throw new Error('Requested worktree does not match the sandbox workspace');
    }
    if (options.resume) {
      const checkpoint = options.resume.checkpoint as NativeSessionCheckpoint;
      if (resolve(checkpoint.worktreePath) !== resolve(worktreePath)
        || resolve(checkpoint.workspacePath ?? checkpoint.worktreePath) !== resolve(workspacePath)) {
        throw new Error(`Invalid ${this.name} native session workspace`);
      }
    }
    const parser = this.createParser();
    let sessionId: string | undefined;
    let usage: TokenUsage | undefined;
    let sessionError: string | undefined;
    let execution: AgentExecution | undefined;
    const expectedSessionId = this.resumeSessionId(commandOptions);
    const parseLine = this.nativeSessions && parser ? (line: string): AgentEvent[] => {
      const events = parser(line);
      for (const event of events) {
        if (event.type === 'usage') usage = event.usage;
        if (event.type === 'session') {
          if (!this.validSessionId(event.sessionId)
            || (expectedSessionId !== undefined && event.sessionId !== expectedSessionId)
            || (sessionId !== undefined && event.sessionId !== sessionId)
            || (event.worktreePath !== undefined && (!isAbsolute(event.worktreePath)
              || resolve(event.worktreePath) !== resolve(workspacePath)))) {
            sessionError = 'Native session identity does not match the requested execution';
          } else sessionId = event.sessionId;
        }
      }
      if (sessionError) {
        sessionId = undefined;
        void execution?.kill().catch(() => {});
        return [...events.filter(event => event.type !== 'session'), { type: 'error', error: new Error(sessionError) }];
      }
      return events;
    } : parser;
    execution = await options.sandbox.startAgent({
      command: this.buildCommand({ ...commandOptions, worktreePath: workspacePath }),
      generation: options.generation,
      prompt: options.prompt,
      signalType: options.signalType,
      executionMode,
      metadata: this.executionMetadata(options),
      parseLine,
    });
    if (!this.nativeSessions) return execution;
    const source = execution;
    if (sessionError) await source.kill();
    return {
      id: source.id,
      get sessionId() { return sessionId; },
      get metadata() { return { ...source.metadata, threadId: sessionId }; },
      waitForEvent: () => source.waitForEvent(),
      waitForResult: async resultOptions => {
        const result = await source.waitForResult(resultOptions);
        const error = result.exitCode !== undefined && result.exitCode !== 0
          ? { code: 'NON_ZERO_EXIT', message: result.error?.message || `process exited with code ${result.exitCode}` }
          : sessionError
          ? { code: 'NATIVE_SESSION_MISMATCH', message: sessionError }
          : expectedSessionId && !sessionId && result.status === 'completed'
            ? { code: 'NATIVE_SESSION_UNCONFIRMED', message: 'The CLI did not confirm the resumed native session' }
            : undefined;
        if (error) await source.kill();
        return { ...result, sessionId, ...(error ? { status: 'failed' as const, error } : {}) };
      },
      interrupt: reason => source.interrupt(reason),
      kill: () => source.kill(),
      captureOutput: captureOptions => source.captureOutput(captureOptions),
      captureSession: async () => {
        if (!sessionId || sessionError) return undefined;
        const capturedSessionId = sessionId;
        const summary = (await source.captureOutput()).slice(-4000);
        if (sessionError || sessionId !== capturedSessionId) return undefined;
        const checkpoint: NativeSessionCheckpoint = { version: 1, provider: this.name, sessionId: capturedSessionId, worktreePath: resolve(worktreePath),
          ...(resolve(workspacePath) !== resolve(worktreePath) ? { workspacePath: resolve(workspacePath) } : {}) };
        return { sessionId: capturedSessionId, generation: options.generation, checkpoint, summary,
          usage, capturedAt: new Date().toISOString() };
      },
      resume: resumeOptions => this.createExecution({ ...options, prompt: resumeOptions.prompt ?? options.prompt,
        resume: resumeOptions.snapshot, generation: resumeOptions.snapshot.generation + 1 }),
    };
  }

  async captureSession(_options: CaptureSessionOptions): Promise<SessionSnapshot> {
    throw new Error('Capture native sessions from their execution, not a logical session ID');
  }

  async restoreSession(options: RestoreSessionOptions): Promise<void> {
    this.validateNativeSession(options);
  }

  protected createParser(): ((line: string) => AgentEvent[]) | undefined {
    return this.parseLine?.bind(this);
  }

  protected resumeSessionId(options: AgentCommandOptions): string | undefined {
    return options.resume ? this.validateNativeSession({ snapshot: options.resume, worktreePath: options.worktreePath }) : undefined;
  }

  private validateNativeSession(options: RestoreSessionOptions): string {
    const snapshot = options.snapshot;
    const checkpoint = snapshot?.checkpoint as Partial<NativeSessionCheckpoint> | null;
    if (!this.nativeSessions || !snapshot || !this.validSessionId(snapshot.sessionId)
      || !Number.isSafeInteger(snapshot.generation) || snapshot.generation < 0
      || !checkpoint || checkpoint.version !== 1 || checkpoint.provider !== this.name
      || checkpoint.sessionId !== snapshot.sessionId || typeof checkpoint.worktreePath !== 'string'
      || (checkpoint.workspacePath !== undefined && (typeof checkpoint.workspacePath !== 'string' || !isAbsolute(checkpoint.workspacePath)))
      || (resolve(checkpoint.worktreePath) !== resolve(options.worktreePath)
        && (typeof checkpoint.workspacePath !== 'string' || resolve(checkpoint.workspacePath) !== resolve(options.worktreePath)))) {
      throw new Error(`Invalid ${this.name} native session snapshot`);
    }
    return snapshot.sessionId;
  }

  private validSessionId(sessionId: unknown): sessionId is string {
    return typeof sessionId === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,255}$/.test(sessionId);
  }

  protected executionMetadata(_options: AgentExecutionOptions): AgentExecutionMetadata {
    return { provider: this.name, transport: 'process' };
  }

  protected assertExecutionProfile(options: AgentCommandOptions): void {
    if (options.executionProfile === 'analysis' && !this.capabilities.has('analysis')) {
      throw new Error(`analysis_unsupported: ${this.name}`);
    }
  }
}
