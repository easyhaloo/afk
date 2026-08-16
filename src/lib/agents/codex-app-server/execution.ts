import { randomUUID } from 'node:crypto';
import type { AgentExecutionMetadata, AgentExecutionOptions, CodexRuntimeSelection, SessionSnapshot } from '../types';
import type {
  AgentExecution,
  CaptureOptions,
  ExecutionEvent,
  ExecutionResult,
  InterruptReason,
  ResumeOptions,
} from '../../sandbox/types';
import { extractGoalComplete } from '../../workflows/execution-protocol';
import { AppServerClient } from './client';
import { normalizeAppServerNotification } from './events';
import { createAppServerTransport, type AppServerTransport } from './transport';

type TransportFactory = (
  runtime: CodexRuntimeSelection,
) => AppServerTransport | Promise<AppServerTransport>;

export class CodexAppServerExecution implements AgentExecution {
  readonly id = randomUUID();
  readonly sessionId?: string;
  readonly metadata: AgentExecutionMetadata;

  private readonly client: AppServerClient;
  private readonly output: string[] = [];
  private readonly events: ExecutionEvent[] = [];
  private readonly eventReaders: Array<(result: IteratorResult<ExecutionEvent>) => void> = [];
  private result?: ExecutionResult;
  private resolveResult!: (result: ExecutionResult) => void;
  private readonly resultPromise: Promise<ExecutionResult>;
  private structuredOutput?: Record<string, unknown>;
  private usage?: ExecutionResult['usage'];
  private threadId?: string;
  private turnId?: string;

  private constructor(
    private readonly options: AgentExecutionOptions,
    private readonly runtime: CodexRuntimeSelection,
    transport: AppServerTransport,
  ) {
    this.sessionId = options.sessionId;
    this.metadata = {
      provider: 'codex',
      transport: 'app-server',
      auth: runtime.auth,
      modelProvider: runtime.provider,
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
    const endpoint = runtime.endpoint ?? 'stdio://';
    if (endpoint === 'stdio://' && options.sandbox.workspacePath !== options.sandbox.worktreePath) {
      throw new Error('Spawned Codex app-server is not supported inside a container sandbox');
    }
    const transport = await createTransport(runtime);
    const execution = new CodexAppServerExecution(options, runtime, transport);
    execution.client.start();
    void execution.consumeNotifications();
    try {
      await withTimeout(execution.initialize(), runtime.startupTimeoutMs);
      return execution;
    } catch (error) {
      await execution.client.close();
      throw error;
    }
  }

  async waitForEvent(): Promise<ExecutionEvent | null> {
    const event = this.events.shift();
    if (event) return event;
    if (this.result) return null;
    const next = await new Promise<IteratorResult<ExecutionEvent>>(resolve => this.eventReaders.push(resolve));
    return next.done ? null : next.value;
  }

  async waitForResult(options?: { completionTimeoutMs?: number; contextHighTokens?: number }): Promise<ExecutionResult> {
    if (this.result) return this.result;
    const timeoutMs = options?.completionTimeoutMs ?? 600_000;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<ExecutionResult>(resolve => {
      timer = setTimeout(() => {
        void this.client.close();
        resolve(this.buildResult('timed_out'));
      }, timeoutMs);
    });
    const result = await Promise.race([this.resultPromise, timeout]);
    if (timer) clearTimeout(timer);
    if (!this.result) this.finish(result);
    return result;
  }

  async interrupt(_reason: InterruptReason): Promise<void> {
    if (this.result) return;
    if (this.threadId && this.turnId) {
      await this.client.request('turn/interrupt', { threadId: this.threadId, turnId: this.turnId });
    }
    this.finish(this.buildResult('aborted'));
    await this.client.close();
  }

  async kill(): Promise<void> {
    if (!this.result) this.finish(this.buildResult('aborted'));
    await this.client.close();
  }

  async captureOutput(_options?: CaptureOptions): Promise<string> {
    return this.output.join('\n').slice(-4_000);
  }

  async captureSession(): Promise<SessionSnapshot | undefined> {
    return undefined;
  }

  async resume(_options: ResumeOptions): Promise<AgentExecution> {
    throw new Error('Codex app-server execution does not support resume');
  }

  private async initialize(): Promise<void> {
    await this.client.request('initialize', {
      clientInfo: { name: 'afk', title: 'AFK', version: '0.1.0' },
    });
    await this.client.notify('initialized');
    const started = await this.client.request<{ thread: { id: string } }>('thread/start', {
      cwd: this.options.worktreePath,
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
      modelProvider: this.runtime.provider,
    });
    this.threadId = started.thread.id;
    this.metadata.threadId = this.threadId;
    const turn = await this.client.request<{ turn: { id: string } }>('turn/start', {
      threadId: this.threadId,
      input: [{ type: 'text', text: this.options.prompt, text_elements: [] }],
    });
    this.turnId = turn.turn.id;
  }

  private async consumeNotifications(): Promise<void> {
    for await (const notification of this.client.notifications()) {
      for (const event of normalizeAppServerNotification(notification)) {
        if (event.type === 'result') {
          this.output.push(event.text);
          this.structuredOutput = extractGoalComplete(event.text);
          this.emit({ type: 'text', text: event.text });
        } else if (event.type === 'usage') {
          this.usage = event.usage;
          this.emit({ type: 'usage', usage: event.usage });
        } else if (event.type === 'error') {
          this.emit({ type: 'error', error: event.error });
          this.finish(this.buildResult('failed', { code: 'AGENT_ERROR', message: event.error.message }));
        } else if (event.type === 'completed') {
          if (this.structuredOutput?.type === this.options.signalType) {
            this.finish(this.buildResult('completed'));
          } else {
            this.finish(this.buildResult('failed', {
              code: 'MISSING_RESULT',
              message: `app-server execution ended without ${this.options.signalType} result`,
            }));
          }
        }
      }
    }
    if (!this.result) {
      this.finish(this.buildResult('failed', {
        code: 'TRANSPORT_CLOSED', message: 'Codex app-server transport closed before completion',
      }));
    }
  }

  private buildResult(status: ExecutionResult['status'], error?: ExecutionResult['error']): ExecutionResult {
    return {
      version: 1,
      runId: this.id,
      status,
      provider: 'app-server',
      sessionId: this.sessionId,
      ...(status === 'completed' ? { structuredOutput: this.structuredOutput } : {}),
      ...(this.usage ? { usage: this.usage } : {}),
      ...(error ? { error } : {}),
      commits: [],
    };
  }

  private finish(result: ExecutionResult): void {
    if (this.result) return;
    this.result = result;
    this.resolveResult(result);
    for (const reader of this.eventReaders.splice(0)) reader({ done: true, value: undefined });
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
