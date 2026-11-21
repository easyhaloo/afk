import { randomUUID } from 'node:crypto';
import { NativeResumeDispatchError } from '../types.js';
import type { AgentToolCallSummary } from '@afk/core';
import type {
  AgentExecution,
  AgentExecutionMetadata,
  AgentExecutionOptions,
  CaptureOptions,
  CodexRuntimeSelection,
  ExecutionEvent,
  ExecutionResult,
  InterruptReason,
  ResumeOptions,
  SessionSnapshot,
} from '../types.js';
import { extractGoalComplete, type GoalCompletePayload } from '../../../shared/goal-complete.js';
import { AppServerClient } from './client.js';
import { checkedWorkspace, NativeUsageError, nativeId, readCheckpoint, resumedUsage, supportsLocalResume, validUsage, type CodexCheckpoint } from './resume.js';
import { normalizeAppServerNotification } from './events.js';
import { collectAgentToolEvent } from '../tool-telemetry.js';
import { createAppServerTransport, type AppServerTransport } from './transport.js';

type TransportFactory = (
  runtime: CodexRuntimeSelection,
) => AppServerTransport | Promise<AppServerTransport>;

interface ThreadResponse {
  thread: { id: string; cwd?: string; status?: { type: string } };
  modelProvider?: string;
  cwd?: string;
  approvalPolicy?: string;
  sandbox?: { type: string };
}

class ResumeRejected extends Error {}

export class CodexAppServerExecution implements AgentExecution {
  readonly id = randomUUID();
  get sessionId(): string { return this.threadId ?? this.options.sessionId; }
  readonly metadata: AgentExecutionMetadata;

  private readonly client: AppServerClient;
  private readonly output: string[] = [];
  private readonly events: ExecutionEvent[] = [];
  private readonly eventReaders: Array<(result: IteratorResult<ExecutionEvent>) => void> = [];
  private result?: ExecutionResult;
  private resultObserved = false;
  private finishPromise?: Promise<void>;
  private resolveResult!: (result: ExecutionResult) => void;
  private readonly resultPromise: Promise<ExecutionResult>;
  private structuredOutput?: GoalCompletePayload;
  private usage?: ExecutionResult['usage'];
  private readonly tools = new Map<string, AgentToolCallSummary>();
  private threadId?: string;
  private turnId?: string;
  private workspace?: string;
  private modelProvider?: string;
  private checkpoint?: CodexCheckpoint;
  private resumedWatermark?: ReturnType<typeof resumedUsage>;
  private cumulative?: ExecutionResult['usage'];
  private completedNativeTurn = false;
  private turnRequested = false;
  /** Re-arms the idle watchdog whenever the agent says something. */
  private onActivity?: () => void;
  /** When the agent last said something. */
  private lastActivityAt?: string;

  private constructor(
    private readonly options: AgentExecutionOptions,
    private readonly runtime: CodexRuntimeSelection,
    transport: AppServerTransport,
  ) {
    this.metadata = {
      provider: 'codex',
      transport: 'app-server',
      auth: runtime.auth,
      ...(runtime.provider !== 'auto' ? { modelProvider: runtime.provider } : {}),
      endpointKind: transport.endpointKind,
    };
    this.client = new AppServerClient(transport);
    this.resultPromise = new Promise(resolve => { this.resolveResult = resolve; });
  }

  static async start(
    options: AgentExecutionOptions,
    runtime: CodexRuntimeSelection,
    createTransport: TransportFactory = createAppServerTransport,
  ): Promise<CodexAppServerExecution> {
    if (options.resume && !supportsLocalResume({ ...options, runtime })) throw new Error('codex does not support explicit native resume on this transport or sandbox');
    const snapshot = options.resume;
    const checkpoint = snapshot && await readCheckpoint({ snapshot, worktreePath: options.worktreePath });
    if (snapshot && (!Number.isSafeInteger(options.generation) || options.generation !== snapshot.generation + 1)) {
      throw new ResumeRejected('Invalid Codex resume generation');
    }
    let workspace: string | undefined;
    if (supportsLocalResume({ ...options, runtime })) {
      workspace = await checkedWorkspace(options.worktreePath);
      if (workspace !== await checkedWorkspace(options.sandbox.worktreePath) || workspace !== await checkedWorkspace(options.sandbox.workspacePath)) {
        throw new Error('Invalid Codex native session workspace');
      }
    }
    const endpoint = runtime.endpoint ?? 'stdio://';
    if (endpoint === 'stdio://' && options.sandbox.workspacePath !== options.sandbox.worktreePath) {
      throw new Error('Spawned Codex app-server is not supported inside a container sandbox');
    }
    const transport = await createTransport(runtime);
    const execution = new CodexAppServerExecution(options, runtime, transport);
    execution.workspace = workspace;
    execution.checkpoint = checkpoint;
    execution.client.start();
    try {
      await withTimeout(execution.initialize(), runtime.startupTimeoutMs);
    } catch (error) {
      await execution.client.close().catch(() => {});
      if (checkpoint && execution.turnRequested) throw new NativeResumeDispatchError('Codex native resume turn dispatch could not be confirmed');
      if (error instanceof ResumeRejected || error instanceof NativeResumeDispatchError) throw error;
      throw new Error(checkpoint ? 'Codex native resume failed before turn confirmation' : 'Codex app-server startup failed');
    }
    void execution.consumeNotifications().catch(error => {
      void execution.finish(execution.buildResult('failed', error instanceof NativeUsageError
        ? { code: 'NATIVE_USAGE_UNCONFIRMED', message: error.message } : {
        code: 'APP_SERVER_FAILURE', message: 'Codex app-server notification handling failed',
      }));
    });
    return execution;
  }

  async waitForEvent(): Promise<ExecutionEvent | null> {
    const event = this.events.shift();
    if (event) return event;
    if (this.result) return null;
    const next = await new Promise<IteratorResult<ExecutionEvent>>(resolve => this.eventReaders.push(resolve));
    return next.done ? null : next.value;
  }

  async waitForResult(options?: { completionTimeoutMs?: number; contextHighTokens?: number; idleTimeoutMs?: number }): Promise<ExecutionResult> {
    const timeoutMs = options?.completionTimeoutMs ?? 600_000;
    const idleTimeoutMs = options?.idleTimeoutMs;
    const timer = setTimeout(() => {
      void this.finish(this.buildResult('timed_out', undefined, {
        timeout: {
          kind: 'completion',
          budgetMs: timeoutMs,
          lastActivityAt: this.lastActivityAt,
        },
      }));
    }, timeoutMs);
    // The idle watchdog: a turn that says nothing for too long is not
    // working. The app-server reports every turn event as a notification,
    // so the last one says when the agent was last alive.
    let idleTimer: NodeJS.Timeout | undefined;
    if (idleTimeoutMs !== undefined && idleTimeoutMs > 0) {
      const arm = (): void => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          void this.finish(this.buildResult('timed_out', {
            code: 'AGENT_IDLE',
            message: `the agent produced no output for ${Math.round(idleTimeoutMs / 1000)}s`,
          }, {
            timeout: {
              kind: 'idle',
              budgetMs: idleTimeoutMs,
              idleMs: idleTimeoutMs,
              lastActivityAt: this.lastActivityAt,
            },
          }));
        }, idleTimeoutMs);
      };
      arm();
      this.onActivity = arm;
    }
    try {
      const result = await this.resultPromise;
      if (this.resultObserved) return this.result!;
      this.resultObserved = true;
      if (this.modelProvider && this.completedNativeTurn && result.error?.code === 'MISSING_RESULT'
        && result.usage && result.usage.totalTokens >= (options?.contextHighTokens ?? Infinity)) {
        this.result = this.buildResult('context_high');
        return this.result;
      }
      return result;
    } finally {
      clearTimeout(timer);
      if (idleTimer) clearTimeout(idleTimer);
    }
  }

  async interrupt(_reason: InterruptReason): Promise<void> {
    if (this.result) return;
    if (this.threadId && this.turnId) {
      await this.client.request('turn/interrupt', { threadId: this.threadId, turnId: this.turnId });
    }
    await this.finish(this.buildResult('aborted'));
  }

  async kill(): Promise<void> {
    if (!this.result) await this.finish(this.buildResult('aborted'));
    else await (this.finishPromise ?? this.client.close());
  }

  async captureOutput(_options?: CaptureOptions): Promise<string> {
    return this.output.join('\n').slice(-4_000);
  }

  async captureSession(): Promise<SessionSnapshot | undefined> {
    if (!this.completedNativeTurn || !this.workspace || !this.modelProvider || !this.threadId || !this.turnId || !nativeId.test(this.turnId)
      || !this.cumulative || !this.result || !['completed', 'context_high'].includes(this.result.status)) return undefined;
    const checkpoint: CodexCheckpoint = { version: 1, provider: 'codex', transport: 'stdio', sessionId: this.threadId,
      turnId: this.turnId, worktreePath: this.workspace, modelProvider: this.modelProvider, total: { ...this.cumulative } };
    return { sessionId: this.threadId, generation: this.options.generation, checkpoint, usage: this.usage,
      capturedAt: new Date().toISOString(), summary: '' };
  }

  async resume({ snapshot, prompt }: ResumeOptions): Promise<AgentExecution> {
    const current = await this.captureSession();
    if (!current || current.sessionId !== snapshot.sessionId || current.generation !== snapshot.generation) {
      throw new ResumeRejected('Codex execution has no matching resumable session');
    }
    const supplied = await readCheckpoint({ snapshot, worktreePath: this.options.worktreePath });
    if (supplied.turnId !== this.turnId) throw new ResumeRejected('Codex native resume checkpoint is stale');
    return CodexAppServerExecution.start({ ...this.options, prompt: prompt ?? this.options.prompt,
      resume: current, generation: current.generation + 1 }, this.runtime);
  }

  private async initialize(): Promise<void> {
    await this.client.request('initialize', {
      clientInfo: { name: 'afk', title: 'AFK', version: '0.1.0' },
    });
    await this.client.notify('initialized');
    const started = this.checkpoint ? await this.restoreThread(this.checkpoint) : await this.client.request<ThreadResponse>('thread/start', {
      cwd: this.options.worktreePath,
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
      ...(this.runtime.provider !== 'auto' ? { modelProvider: this.runtime.provider } : {}),
    });
    if (this.workspace && nativeId.test(started.thread.id) && started.cwd && started.thread.cwd
      && started.sandbox?.type === 'dangerFullAccess' && started.approvalPolicy === 'never'
      && await checkedWorkspace(started.cwd) === this.workspace && await checkedWorkspace(started.thread.cwd) === this.workspace) {
      this.modelProvider = started.modelProvider;
    }
    if (this.checkpoint && (!this.modelProvider || this.checkpoint.modelProvider !== this.modelProvider
      || (this.runtime.provider !== 'auto' && this.runtime.provider !== this.modelProvider))) {
      throw new ResumeRejected('Codex native resume workspace, provider or permissions changed');
    }
    this.threadId = started.thread.id;
    this.metadata.threadId = this.threadId;
    this.turnRequested = true;
    const turn = await this.client.request<{ turn: { id: string } }>('turn/start', {
      threadId: this.threadId,
      input: [{ type: 'text', text: this.options.prompt, text_elements: [] }],
    });
    this.turnId = turn.turn.id;
    if (this.checkpoint && (!nativeId.test(this.turnId) || this.turnId === this.checkpoint.turnId)) {
      throw new Error('Invalid resumed turn identity');
    }
  }

  private async restoreThread(saved: CodexCheckpoint): Promise<ThreadResponse> {
    const threadId = saved.sessionId;
    const { thread } = await this.client.request<ThreadResponse>('thread/read', { threadId, includeTurns: false });
    if (thread.id !== threadId || !thread.cwd || await checkedWorkspace(thread.cwd) !== this.workspace) {
      throw new ResumeRejected('Codex native thread identity or workspace mismatch');
    }
    if (thread.status?.type === 'active') throw new NativeResumeDispatchError('Codex native thread has an active writer');
    if (thread.status?.type !== 'notLoaded') throw new ResumeRejected('Codex native thread state mismatch');
    const resumed = await this.client.request<ThreadResponse>('thread/resume', { threadId, excludeTurns: true }).catch(error => {
      if (error instanceof Error && /\bactive writer\b/i.test(error.message)) {
        throw new NativeResumeDispatchError('Codex native thread has an active writer');
      }
      throw error;
    });
    if (resumed.thread.id !== threadId) throw new ResumeRejected('Codex native resume returned a different thread');
    const { data } = await this.client.request<{ data: Array<{ id: string; status: string }> }>('thread/turns/list', {
      threadId, limit: 1, sortDirection: 'desc', itemsView: 'notLoaded',
    });
    if (data[0]?.id !== saved.turnId || data[0].status !== 'completed') throw new ResumeRejected('Codex native resume checkpoint is stale');
    return resumed;
  }

  private async consumeNotifications(): Promise<void> {
    for await (const notification of this.client.notifications()) {
      const params = notification.params as { threadId?: string; turnId?: string; turn?: { id?: string; status?: string }; tokenUsage?: { total?: unknown; last?: unknown } } | undefined;
      if (this.modelProvider && notification.method === 'turn/completed' && params && params.threadId === this.threadId) {
        const turn = params.turn;
        if (params.turnId !== this.turnId && turn?.id !== this.turnId) continue;
        if (!turn || turn.id !== this.turnId || (params.turnId !== undefined && params.turnId !== turn.id) || typeof turn.status !== 'string') {
          await this.finish(this.buildResult('failed', { code: 'NATIVE_TURN_UNCONFIRMED', message: 'Codex native turn completion could not be confirmed' }));
          return;
        }
      }
      if (this.modelProvider && (params?.threadId !== this.threadId || (params?.turnId ?? params?.turn?.id) !== this.turnId)) continue;
      // The agent just said something, whatever it was.
      this.lastActivityAt = new Date().toISOString();
      this.onActivity?.();
      collectAgentToolEvent('codex', notification, this.tools);
      for (const event of normalizeAppServerNotification(notification)) {
        if (event.type === 'result') {
          this.output.push(event.text);
          this.structuredOutput = extractGoalComplete(event.text);
          this.emit({ type: 'text', text: event.text });
        } else if (event.type === 'usage') {
          const total = params?.tokenUsage?.total;
          if (this.modelProvider && !validUsage(total)) throw new NativeUsageError('Invalid Codex cumulative token usage');
          if (this.checkpoint) this.resumedWatermark = resumedUsage(total, params?.tokenUsage?.last, this.checkpoint.total, this.resumedWatermark);
          this.usage = this.resumedWatermark?.delta ?? event.usage;
          this.cumulative = this.resumedWatermark?.total ?? event.usage;
          this.emit({ type: 'usage', usage: this.usage });
        } else if (event.type === 'error') {
          this.emit({ type: 'error', error: event.error });
          await this.finish(this.buildResult('failed', { code: 'AGENT_ERROR', message: event.error.message }));
          return;
        } else if (event.type === 'completed') {
          this.completedNativeTurn = event.status === 'completed';
          this.structuredOutput ??= extractGoalComplete(this.output.join(''));
          if (this.checkpoint && !this.usage) {
            await this.finish(this.buildResult('failed', { code: 'NATIVE_USAGE_UNCONFIRMED', message: 'Codex resumed turn has no confirmed usage' }));
          } else if (this.structuredOutput?.type === this.options.signalType && event.status === 'completed') {
            await this.finish(this.buildResult('completed'));
          } else {
            await this.finish(this.buildResult('failed', {
              code: 'MISSING_RESULT',
              message: `app-server execution ended without ${this.options.signalType} result`,
            }));
          }
          return;
        }
      }
    }
    if (!this.result) {
      await this.finish(this.buildResult('failed', {
        code: 'TRANSPORT_CLOSED', message: 'Codex app-server transport closed before completion',
      }));
    }
  }

  private buildResult(status: ExecutionResult['status'], error?: ExecutionResult['error'], diagnostics?: ExecutionResult['diagnostics']): ExecutionResult {
    return {
      version: 1,
      runId: this.id,
      status,
      provider: 'app-server',
      sessionId: this.sessionId,
      ...(status === 'completed' ? { structuredOutput: this.structuredOutput } : {}),
      ...(this.usage ? { usage: this.usage } : {}),
      ...(this.checkpoint ? { cumulativeSessionTokens: this.cumulative?.totalTokens ?? this.checkpoint.total.totalTokens } : {}),
      ...(this.tools.size ? { tools: [...this.tools.values()] } : {}),
      ...(error ? { error } : {}),
      ...(diagnostics ? { diagnostics } : {}),
      commits: [],
    };
  }

  private finish(result: ExecutionResult): Promise<void> {
    if (this.finishPromise) return this.finishPromise;
    this.result = result;
    for (const reader of this.eventReaders.splice(0)) reader({ done: true, value: undefined });
    this.finishPromise = (async () => {
      let finalResult = result;
      try {
        await this.client.close();
      } catch {
        finalResult = this.buildResult('failed', {
          code: 'TRANSPORT_CLOSE_FAILED', message: 'Codex app-server cleanup failed',
        });
      }
      this.result = finalResult;
      this.resolveResult(finalResult);
    })();
    return this.finishPromise;
  }

  private emit(event: ExecutionEvent): void {
    const reader = this.eventReaders.shift();
    if (reader) reader({ done: false, value: event });
    else this.events.push(event);
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('Codex app-server startup timed out')), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
