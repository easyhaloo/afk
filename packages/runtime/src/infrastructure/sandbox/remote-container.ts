import { z } from 'zod';
import type {
  AgentExecution, AgentExecutionMetadata, AgentStartOptions, CaptureOptions, ExecutionEvent,
  ExecutionResult, InterruptReason, ResumeOptions, SessionSnapshot,
} from '../../domain/agents/types.js';
import type { Sandbox, SandboxOptions, SandboxProvider, SandboxCapability, WorktreeInfo } from './types.js';
import { createHostCommandExecutor, validateTimeout } from '../host/command.js';
import type { ProviderHealth } from '../../plugin-sdk/capabilities.js';

export interface RemoteRequestOptions {
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface RemoteExecutionReference {
  readonly sandboxId: string;
  readonly executionId: string;
}

export interface RemoteContainerPayloads {
  'workspace.create': { readonly iid: number; readonly baseBranch: string };
  'sandbox.create': Pick<SandboxOptions, 'worktreePath' | 'session' | 'branch' | 'interactive' | 'env' | 'executionMode' | 'workspaceRoot' | 'runtimeRunId'>;
  'sandbox.close': { readonly sandboxId: string };
  'agent.start': { readonly sandboxId: string; readonly options: Omit<AgentStartOptions, 'parseLine'> };
  'agent.resume': RemoteExecutionReference & { readonly options: ResumeOptions };
  'agent.event.next': RemoteExecutionReference;
  'agent.wait': RemoteExecutionReference & { readonly options?: Parameters<AgentExecution['waitForResult']>[0] };
  'agent.interrupt': RemoteExecutionReference & { readonly reason: InterruptReason };
  'agent.kill': RemoteExecutionReference;
  'agent.output': RemoteExecutionReference & { readonly options?: CaptureOptions };
  'agent.capture-session': RemoteExecutionReference;
}

export type RemoteContainerOperation = keyof RemoteContainerPayloads;

export interface RemoteContainerTransport {
  readonly kind: 'cli' | 'http';
  request<Op extends RemoteContainerOperation>(operation: Op, payload: RemoteContainerPayloads[Op], options?: RemoteRequestOptions): Promise<unknown>;
  health?(): Promise<boolean>;
}

const text = z.string().refine(value => value.trim().length > 0, 'non-blank string is required');
const count = z.number().int().nonnegative().finite();
const usage = z.object({ inputTokens: count, outputTokens: count, totalTokens: count });
const metadata = z.object({
  provider: text, transport: z.enum(['process', 'exec', 'app-server']),
  auth: z.enum(['chatgpt', 'api', 'unknown']).optional(), modelProvider: text.optional(),
  endpointKind: z.enum(['stdio', 'unix', 'ws', 'wss']).optional(), threadId: text.optional(),
});
const snapshot = z.object({
  sessionId: text, generation: count, checkpoint: z.unknown(), summary: z.string(), usage: usage.optional(),
  capturedAt: z.string().datetime({ offset: true }),
}).refine(value => Object.hasOwn(value, 'checkpoint'), 'session checkpoint is required')
  .transform(value => ({ ...value, checkpoint: value.checkpoint }));
const executionInfo = z.object({ id: text, sessionId: text.optional(), metadata });
const resultSchema = z.object({
  version: z.literal(1), runId: text,
  status: z.enum(['completed', 'blocked', 'failed', 'aborted', 'timed_out', 'context_high']),
  provider: text, sessionId: text.optional(), exitCode: z.number().int().optional(),
  structuredOutput: z.unknown().optional(), usage: usage.optional(), commits: z.array(text), branch: text.optional(),
  tools: z.array(z.object({
    id: text, name: text, result: z.enum(['succeeded', 'failed', 'unknown', 'in_progress']),
    exitCode: z.number().int().optional(), startedAt: text.optional(), completedAt: text.optional(), durationMs: count.optional(),
  })).optional(),
  error: z.object({ code: text, message: z.string() }).optional(),
  diagnostics: z.object({ timeout: z.object({
    kind: z.enum(['idle', 'completion', 'hard']), budgetMs: count, idleMs: count.optional(), lastActivityAt: text.optional(),
  }).optional() }).optional(),
});
const errorSchema = z.union([
  z.instanceof(Error),
  z.object({ message: z.string(), name: text.optional(), stack: z.string().optional() }).transform(value => {
    const error = new Error(value.message);
    if (value.name) error.name = value.name;
    if (value.stack) error.stack = value.stack;
    return error;
  }),
]);
const event = z.union([
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({ type: z.literal('usage'), usage }),
  z.object({ type: z.literal('error'), error: errorSchema }),
  z.object({ type: z.literal('interrupt-acked') }), z.object({ type: z.literal('killed') }),
]);
const ack = z.object({ ok: z.literal(true) });
const responses = {
  'workspace.create': z.object({ iid: z.number().int().positive(), path: text, branch: text }),
  'sandbox.create': z.object({ id: text, workspacePath: text.optional() }),
  'sandbox.close': ack,
  'agent.start': executionInfo, 'agent.resume': executionInfo,
  'agent.event.next': event.nullable(), 'agent.wait': resultSchema,
  'agent.interrupt': ack, 'agent.kill': ack,
  'agent.output': z.object({ output: z.string() }), 'agent.capture-session': snapshot.nullable(),
};
type Operation = keyof typeof responses;

function validateResponse<Schema extends z.ZodTypeAny>(schema: Schema, value: unknown, operation: string): z.output<Schema> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new Error(`invalid remote container response for ${operation}: ${parsed.error.message}`);
  return parsed.data;
}

function operationSchema(operation: string): z.ZodTypeAny {
  if (!Object.hasOwn(responses, operation)) throw new Error(`unsupported remote container operation: ${operation}`);
  return responses[operation as Operation];
}

async function request<Op extends Operation>(
  transport: RemoteContainerTransport, operation: Op, payload: RemoteContainerPayloads[Op], options?: RemoteRequestOptions,
): Promise<z.output<(typeof responses)[Op]>> {
  return validateResponse(responses[operation], await transport.request(operation, payload, options), operation);
}

export interface RemoteContainerCliTransportOptions {
  readonly command?: string;
  readonly timeoutMs?: number;
  readonly run?: (argv: readonly string[], options?: RemoteRequestOptions) => Promise<{
    readonly exitCode: number; readonly stdout: string; readonly stderr: string;
  }>;
}

export function createRemoteContainerCliTransport(options: RemoteContainerCliTransportOptions = {}): RemoteContainerTransport {
  if (!options.command?.trim()) throw new Error('remote container CLI transport requires an explicitly configured protocol client command');
  const command = options.command;
  const timeoutMs = validateTimeout(options.timeoutMs);
  const exec = createHostCommandExecutor();
  const run = options.run ?? (async (argv, requestOptions) => {
    const result = await exec(argv[0], argv.slice(1), requestOptions);
    if (result.code === null) throw new Error('remote container CLI terminated without an exit code');
    return { exitCode: result.code, stdout: result.stdout, stderr: result.stderr };
  });
  return {
    kind: 'cli',
    async request(operation, payload, requestOptions) {
      const schema = operationSchema(operation);
      const result = await run([command, operation, JSON.stringify(payload)], {
        timeoutMs: requestOptions?.timeoutMs ?? timeoutMs, signal: requestOptions?.signal,
      });
      if (!result || !Number.isInteger(result.exitCode) || typeof result.stdout !== 'string' || typeof result.stderr !== 'string') {
        throw new Error('remote container CLI returned an invalid process result');
      }
      if (result.exitCode !== 0) throw new Error(result.stderr || `remote container CLI exited with ${result.exitCode}`);
      let parsed: unknown;
      try { parsed = JSON.parse(result.stdout); } catch { throw new Error('remote container CLI returned invalid JSON'); }
      return validateResponse(schema, parsed, operation);
    },
  };
}

export interface RemoteContainerHttpTransportOptions {
  readonly baseUrl?: string;
  readonly token?: string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly fetch?: typeof globalThis.fetch;
  readonly request?: RemoteContainerTransport['request'];
  readonly health?: () => Promise<boolean>;
}

export function createRemoteContainerHttpTransport(options: RemoteContainerHttpTransportOptions): RemoteContainerTransport {
  const timeoutMs = validateTimeout(options.timeoutMs);
  if (options.request) {
    return {
      kind: 'http', health: options.health,
      async request(operation, payload, requestOptions) {
        return validateResponse(operationSchema(operation), await options.request!(operation, payload, requestOptions), operation);
      },
    };
  }
  if (!options.baseUrl) throw new Error('remote container HTTP transport requires baseUrl');
  const base = new URL(options.baseUrl);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) {
    throw new Error('remote container baseUrl must be an HTTP(S) URL without credentials, query or fragment');
  }
  base.pathname = `${base.pathname.replace(/\/+$/, '')}/`;
  if (options.token !== undefined && (!options.token || /[\r\n]/.test(options.token))) throw new Error('invalid remote container bearer token');
  const fetch = options.fetch ?? globalThis.fetch;

  async function send(operation: string, payload?: RemoteContainerPayloads[RemoteContainerOperation], requestOptions?: RemoteRequestOptions): Promise<unknown> {
    const controller = new AbortController();
    const budget = validateTimeout(requestOptions?.timeoutMs ?? timeoutMs);
    const timer = setTimeout(() => controller.abort(new DOMException(`remote container ${operation} timed out after ${budget}ms`, 'TimeoutError')), budget);
    const signal = AbortSignal.any([controller.signal, ...[options.signal, requestOptions?.signal].filter((value): value is AbortSignal => value !== undefined)]);
    try {
      const response = await fetch(new URL(operation, base), {
        method: payload === undefined ? 'GET' : 'POST', redirect: 'error', signal,
        headers: {
          Accept: 'application/json', ...(payload === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(options.token === undefined ? {} : { Authorization: `Bearer ${options.token}` }),
        },
        body: payload === undefined ? undefined : JSON.stringify(payload),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`remote container ${operation} returned HTTP ${response.status}`);
      }
      const contentType = response.headers.get('content-type') ?? '';
      if (!/^application\/(?:[\w.-]+\+)?json(?:\s*;|$)/i.test(contentType)) {
        await response.body?.cancel();
        throw new Error(`remote container ${operation} returned a non-JSON content type`);
      }
      let data: unknown;
      try { data = await response.json(); } catch (error) {
        if (signal.aborted) throw signal.reason;
        throw new Error(`remote container ${operation} returned invalid JSON`, { cause: error });
      }
      if (signal.aborted) throw signal.reason;
      return data;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    kind: 'http',
    async request(operation, payload, requestOptions) {
      const schema = operationSchema(operation);
      return validateResponse(schema, await send(operation, payload, requestOptions), operation);
    },
    health: options.health ?? (async () => validateResponse(z.object({ healthy: z.boolean() }), await send('health'), 'health').healthy),
  };
}

const REMOTE_CAPABILITIES: ReadonlySet<SandboxCapability> = new Set([
  'streaming-exec', 'interrupt-process', 'kill-process', 'persistent-filesystem', 'session-transfer',
]);

export class RemoteContainerSandboxProvider implements SandboxProvider {
  readonly name = 'remote-container';
  readonly isolation = 'filesystem' as const;
  readonly capabilities = REMOTE_CAPABILITIES;
  readonly health?: () => Promise<ProviderHealth>;

  constructor(private readonly transport: RemoteContainerTransport) {
    const probe = transport.health?.bind(transport);
    if (probe) this.health = async () => {
      try {
        return await probe()
          ? { status: 'ok', message: 'Remote container health probe succeeded; execution readiness was not checked' }
          : { status: 'unavailable', message: 'Remote container health probe reported unavailable' };
      } catch {
        return { status: 'unavailable', message: 'Remote container health probe failed' };
      }
    };
  }

  async createWorktree(options: { iid: number; baseBranch: string }): Promise<WorktreeInfo> {
    return request(this.transport, 'workspace.create', options);
  }

  async create(options: SandboxOptions): Promise<Sandbox> {
    if (!options.worktreePath?.trim()) throw new Error('remote container requires a remote worktree reference');
    const result = await request(this.transport, 'sandbox.create', {
      worktreePath: options.worktreePath, session: options.session, branch: options.branch,
      interactive: options.interactive, env: options.env, executionMode: options.executionMode,
      workspaceRoot: options.workspaceRoot, runtimeRunId: options.runtimeRunId,
    });
    return new RemoteContainerSandbox(this.transport, result.id, result.workspacePath ?? options.worktreePath);
  }
}

class RemoteContainerSandbox implements Sandbox {
  readonly worktreePath: string;
  readonly workspacePath: string;
  private closed = false;
  private closing?: Promise<void>;

  constructor(private readonly transport: RemoteContainerTransport, readonly id: string, workspacePath: string) {
    this.worktreePath = workspacePath;
    this.workspacePath = workspacePath;
  }

  assertOpen = (): void => {
    if (this.closed || this.closing) throw new Error('remote container sandbox is closed or closing');
  };

  async startAgent(options: AgentStartOptions): Promise<AgentExecution> {
    this.assertOpen();
    const serializable = z.object({
      command: z.object({ argv: z.array(z.string().refine(value => !value.includes('\0'))).nonempty(), env: z.record(z.string()).optional(), cwd: text.optional() }),
      metadata, generation: count, prompt: z.string(), signalType: z.literal('goal_complete'), executionMode: z.enum(['interactive', 'batch']).optional(),
    }).parse(options);
    if (!serializable.command.argv[0]) throw new Error('remote agent command must not be empty');
    const info = await request(this.transport, 'agent.start', { sandboxId: this.id, options: serializable });
    this.assertOpen();
    if (info.metadata.provider !== options.metadata.provider) throw new Error('remote agent provider does not match the start request');
    return new RemoteAgentExecution(this.transport, this.id, info, this.assertOpen);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    if (this.closing) return this.closing;
    this.closing = request(this.transport, 'sandbox.close', { sandboxId: this.id }).then(() => { this.closed = true; });
    try { await this.closing; } finally { this.closing = undefined; }
  }
}

class RemoteAgentExecution implements AgentExecution {
  readonly id: string;
  readonly sessionId?: string;
  readonly metadata: AgentExecutionMetadata;
  private state: 'running' | 'interrupted' | 'killed' | 'terminal' | 'resumed' = 'running';
  private result?: Promise<ExecutionResult>;
  private streamEnded = false;
  private resuming = false;

  constructor(
    private readonly transport: RemoteContainerTransport, private readonly sandboxId: string,
    info: z.infer<typeof executionInfo>, private readonly assertOpen: () => void,
  ) {
    this.id = info.id;
    this.sessionId = info.sessionId;
    this.metadata = info.metadata;
  }

  private payload(): { sandboxId: string; executionId: string } {
    this.assertOpen();
    if (this.state === 'resumed') throw new Error('remote agent execution was superseded by resume');
    if (this.resuming) throw new Error('remote agent execution is resuming');
    return { sandboxId: this.sandboxId, executionId: this.id };
  }

  private markStopped(next: 'interrupted' | 'killed'): void {
    if (this.state === 'running' || (this.state === 'interrupted' && next === 'killed')) this.state = next;
  }

  async waitForEvent(): Promise<ExecutionEvent | null> {
    const payload = this.payload();
    if (this.streamEnded || this.state === 'terminal') return null;
    const value = await request(this.transport, 'agent.event.next', payload);
    this.payload();
    if (value === null) this.streamEnded = true;
    else if (value.type === 'interrupt-acked') this.markStopped('interrupted');
    else if (value.type === 'killed') this.markStopped('killed');
    return value;
  }

  async waitForResult(options?: { completionTimeoutMs?: number; contextHighTokens?: number; idleTimeoutMs?: number }): Promise<ExecutionResult> {
    const payload = this.payload();
    if (this.result) return this.result;
    if (options?.completionTimeoutMs !== undefined) validateTimeout(options.completionTimeoutMs);
    this.result = request(this.transport, 'agent.wait', { ...payload, options }, {
      timeoutMs: options?.completionTimeoutMs === undefined ? undefined : Math.min(2147483647, options.completionTimeoutMs + 1000),
    }).then(value => {
      this.payload();
      if (value.provider !== this.metadata.provider || (value.sessionId && this.sessionId && value.sessionId !== this.sessionId)) {
        throw new Error('remote result does not match the agent provider/session');
      }
      if (value.status === 'completed' && value.exitCode !== undefined && value.exitCode !== 0) {
        throw new Error('remote result reports completed with a nonzero exit code');
      }
      if (value.status === 'completed' && value.error !== undefined) throw new Error('remote result reports completed with an error');
      this.state = 'terminal';
      return value;
    }).catch(error => { this.result = undefined; throw error; });
    return this.result;
  }

  async interrupt(reason: InterruptReason): Promise<void> {
    const payload = this.payload();
    if (this.state !== 'running') return;
    await request(this.transport, 'agent.interrupt', { ...payload, reason });
    this.payload();
    this.markStopped('interrupted');
  }

  async kill(): Promise<void> {
    const payload = this.payload();
    if (this.state === 'terminal' || this.state === 'killed') return;
    await request(this.transport, 'agent.kill', payload);
    this.payload();
    this.markStopped('killed');
  }

  async captureOutput(options?: CaptureOptions): Promise<string> {
    const value = await request(this.transport, 'agent.output', { ...this.payload(), options });
    this.payload();
    return value.output;
  }

  async captureSession(): Promise<SessionSnapshot | undefined> {
    const value = await request(this.transport, 'agent.capture-session', this.payload());
    this.payload();
    return value ?? undefined;
  }

  async resume(options: ResumeOptions): Promise<AgentExecution> {
    const payload = this.payload();
    if (this.state === 'running') throw new Error('interrupt or finish the remote agent before resuming');
    const captured = validateResponse(snapshot, options.snapshot, 'resume snapshot');
    this.resuming = true;
    try {
      const info = await request(this.transport, 'agent.resume', { ...payload, options: { snapshot: captured } });
      this.assertOpen();
      if (info.metadata.provider !== this.metadata.provider) throw new Error('remote resumed agent provider does not match');
      this.state = 'resumed';
      return new RemoteAgentExecution(this.transport, this.sandboxId, info, this.assertOpen);
    } finally { this.resuming = false; }
  }
}
