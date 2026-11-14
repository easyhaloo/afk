import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import { realpathSync, statSync } from 'node:fs';
import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';
import { isAbsolute, join, relative } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { guardedRestoreSession, type AgentProviderRegistry } from '../../domain/agents/registry.js';
import type { AgentExecution, AgentExecutionOptions, AgentProvider, ExecutionResult, SessionSnapshot } from '../../domain/agents/types.js';
import type { SandboxProviderDeps, SandboxProviderRegistry } from './registry.js';
import type { Sandbox } from './types.js';
import { remoteExecutionRuntimeSchema } from './remote-container.js';

export interface RemoteContainerServerOptions {
  readonly enabled?: boolean;
  readonly token: string;
  readonly workspaceRoot: string;
  readonly sandboxes: SandboxProviderRegistry;
  readonly sandboxDeps: SandboxProviderDeps;
  readonly sandboxProviderId: string;
  readonly agents: AgentProviderRegistry;
  readonly allowedAgents: readonly string[];
  readonly basePath?: string;
  readonly allowRemote?: boolean;
  readonly maxSandboxes?: number;
  readonly maxExecutionsPerSandbox?: number;
  readonly maxBodyBytes?: number;
  readonly requestTimeoutMs?: number;
  readonly executionTimeoutMs?: number;
}

export interface RemoteContainerServer {
  readonly handle: RequestListener;
  close(): Promise<void>;
}

const name = z.string().min(1).max(256);
const identifier = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/);
const positive = z.number().int().positive().max(2147483647);
const sessionSchema = z.object({
  sessionId: name, generation: z.number().int().nonnegative().max(2147483646), checkpoint: z.unknown(), summary: z.string(),
  usage: z.object({ inputTokens: z.number().nonnegative(), outputTokens: z.number().nonnegative(), totalTokens: z.number().nonnegative() }).optional(),
  capturedAt: z.string().datetime({ offset: true }),
}).refine(value => Object.hasOwn(value, 'checkpoint')).transform(value => ({ ...value, checkpoint: value.checkpoint }));
const executionReference = z.object({ sandboxId: identifier, executionId: identifier });
const command = z.object({ argv: z.array(z.string()).nonempty(), cwd: z.string().optional(), env: z.record(z.string()).optional() }).strict();
const startOptions = z.object({
  command,
  metadata: z.object({
    provider: name, transport: z.enum(['process', 'exec', 'app-server']), auth: z.enum(['chatgpt', 'api', 'unknown']).optional(),
    modelProvider: name.optional(), endpointKind: z.enum(['stdio', 'unix', 'ws', 'wss']).optional(), threadId: name.optional(),
  }).strict(),
  generation: z.number().int().nonnegative().max(2147483646), prompt: z.string(), signalType: z.literal('goal_complete'),
  executionMode: z.literal('batch').optional(),
  runtime: remoteExecutionRuntimeSchema.optional(),
}).strict().refine(value => value.runtime?.kind !== 'codex' || value.metadata.provider === 'codex', 'runtime does not match provider');
const requests = {
  'workspace.create': z.object({
    iid: z.number().int().positive().safe(),
    baseBranch: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9/._-]*$/).refine(value => !value.includes('..') && !value.endsWith('/')),
  }).strict(),
  'sandbox.create': z.object({
    worktreePath: z.string().min(1), session: identifier, branch: name.optional(), interactive: z.literal(false).optional(),
    executionMode: z.literal('batch').optional(), workspaceRoot: z.string().optional(), runtimeRunId: identifier.optional(),
  }).strict(),
  'sandbox.close': z.object({ sandboxId: identifier }).strict(),
  'agent.start': z.object({ sandboxId: identifier, options: startOptions }).strict(),
  'agent.resume': executionReference.extend({ options: z.object({ snapshot: sessionSchema, prompt: z.string().optional() }).strict() }).strict(),
  'agent.event.next': executionReference.strict(),
  'agent.wait': executionReference.extend({ options: z.object({
    completionTimeoutMs: positive.optional(), contextHighTokens: positive.optional(), idleTimeoutMs: positive.optional(),
  }).strict().optional() }).strict(),
  'agent.interrupt': executionReference.extend({ reason: z.enum(['context-high', 'timeout', 'manual', 'error']) }).strict(),
  'agent.kill': executionReference.strict(),
  'agent.output': executionReference.extend({ options: z.object({
    lines: z.number().int().nonnegative().max(10000).optional(), history: z.number().int().nonnegative().max(10000).optional(),
  }).strict().optional() }).strict(),
  'agent.capture-session': executionReference.strict(),
};

class HttpFailure extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

interface ExecutionEntry {
  readonly execution: AgentExecution;
  readonly agent: AgentProvider;
  readonly options: AgentExecutionOptions;
  readonly timer: ReturnType<typeof setTimeout>;
  state: 'running' | 'interrupted' | 'stopped' | 'terminal' | 'superseded';
  result?: Promise<ExecutionResult>;
  snapshot?: SessionSnapshot;
  sessionInvalidated?: boolean;
  failure?: Error;
  stopReason?: 'interrupt' | 'kill' | 'timeout';
}

interface SandboxEntry {
  readonly sandbox: Sandbox;
  readonly executions: Map<string, ExecutionEntry>;
  busy: boolean;
  closing?: Promise<void>;
}

function limit(value: number | undefined, fallback: number): number {
  return positive.parse(value ?? fallback);
}

function readBody(request: IncomingMessage, maxBytes: number, timeoutMs: number): Promise<unknown> {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] ?? '') || request.headers['content-encoding']) {
    throw new HttpFailure(415, 'CONTENT_TYPE', 'application/json without content encoding is required');
  }
  if (Number(request.headers['content-length']) > maxBytes) throw new HttpFailure(413, 'BODY_LIMIT', 'request body is too large');
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const timer = setTimeout(() => fail(new HttpFailure(408, 'BODY_TIMEOUT', 'request body timed out')), timeoutMs);
    const clean = () => {
      clearTimeout(timer);
      request.off('data', data);
      request.off('end', end);
      request.off('error', fail);
      request.off('aborted', aborted);
    };
    const fail = (error: Error) => { clean(); request.resume(); reject(error); };
    const aborted = () => fail(new HttpFailure(400, 'BODY_ABORTED', 'request body was aborted'));
    const data = (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) fail(new HttpFailure(413, 'BODY_LIMIT', 'request body is too large'));
      else chunks.push(Buffer.from(chunk));
    };
    const end = () => {
      clean();
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new HttpFailure(400, 'INVALID_JSON', 'request body is not valid JSON')); }
    };
    request.on('data', data);
    request.once('end', end);
    request.once('error', fail);
    request.once('aborted', aborted);
  });
}

export function createRemoteContainerServer(options: RemoteContainerServerOptions): RemoteContainerServer {
  if (options.enabled !== true) throw new Error('remote container server is disabled; explicitly set enabled: true');
  if (Buffer.byteLength(options.token ?? '') < 32 || /[\r\n]/.test(options.token)) throw new Error('remote container server requires a bearer token of at least 32 bytes');
  const tokenDigest = createHash('sha256').update(`Bearer ${options.token}`).digest();
  const root = realpathSync(options.workspaceRoot);
  if (!statSync(root).isDirectory()) throw new Error('remote workspaceRoot must be a directory');
  const basePath = options.basePath ?? '/';
  if (!/^\/(?:[a-zA-Z0-9_-]+\/)*$/.test(basePath)) throw new Error('basePath must start and end with a slash and contain plain path segments');
  const agents = new Map(options.allowedAgents.map(id => [id, options.agents.require(id)]));
  if (!agents.size) throw new Error('at least one explicitly allowed agent provider is required');
  const provider = options.sandboxes.create(options.sandboxProviderId, options.sandboxDeps);
  const maxSandboxes = limit(options.maxSandboxes, 16);
  const maxExecutions = limit(options.maxExecutionsPerSandbox, 64);
  const maxBodyBytes = limit(options.maxBodyBytes, 1024 * 1024);
  const bodyTimeoutMs = limit(options.requestTimeoutMs, 10000);
  const executionTimeoutMs = limit(options.executionTimeoutMs, 600000);
  const sandboxes = new Map<string, SandboxEntry>();
  const pendingCreations = new Set<Promise<unknown>>();
  const creatingWorkspaces = new Set<number>();
  let creatingSandboxes = 0;
  let closed = false;

  async function workspace(path: string): Promise<string> {
    let resolved: string;
    try { resolved = await realpath(path); } catch { throw new HttpFailure(404, 'WORKSPACE_MISSING', 'workspace does not exist'); }
    const child = relative(root, resolved);
    if (child === '..' || child.startsWith('../') || child.startsWith('..\\') || isAbsolute(child)) {
      throw new HttpFailure(403, 'WORKSPACE_DENIED', 'workspace is outside the configured root');
    }
    return resolved;
  }

  function sandbox(id: string): SandboxEntry {
    const entry = sandboxes.get(id);
    if (!entry || entry.closing) throw new HttpFailure(404, 'SANDBOX_MISSING', 'sandbox was not found or is closing');
    return entry;
  }

  function execution(reference: { sandboxId: string; executionId: string }, cleanupRetry = false): ExecutionEntry {
    const entry = sandbox(reference.sandboxId).executions.get(reference.executionId);
    if (!entry || entry.state === 'superseded') throw new HttpFailure(404, 'EXECUTION_MISSING', 'execution was not found or was superseded');
    if (entry.failure && !cleanupRetry) throw entry.failure;
    return entry;
  }

  function register(entry: SandboxEntry, value: AgentExecution, agent: AgentProvider, start: AgentExecutionOptions): { id: string; sessionId?: string; metadata: AgentExecution['metadata'] } {
    const id = randomUUID();
    const timer = setTimeout(() => {
      const running = entry.executions.get(id);
      if (!running || (running.state !== 'running' && running.state !== 'interrupted')) return;
      running.stopReason = 'timeout';
      void value.kill().then(() => {
        if (running.state === 'running' || running.state === 'interrupted') running.state = 'stopped';
      }).catch(error => { if (running.state === 'running' || running.state === 'interrupted') running.failure = error; });
    }, executionTimeoutMs);
    timer.unref();
    entry.executions.set(id, { execution: value, agent, options: start, state: 'running', timer });
    return { id, sessionId: value.sessionId, metadata: { ...value.metadata, provider: agent.name } };
  }

  async function closeSandbox(id: string, entry: SandboxEntry): Promise<void> {
    if (entry.closing) return entry.closing;
    entry.closing = (async () => {
      const outcomes = await Promise.allSettled([...entry.executions.values()].map(async job => {
        clearTimeout(job.timer);
        await job.execution.kill();
      }));
      const errors = outcomes.filter((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected').map(outcome => outcome.reason);
      try { await entry.sandbox.close(); } catch (error) { errors.push(error); }
      if (errors.length) throw new AggregateError(errors, 'remote sandbox cleanup failed');
      sandboxes.delete(id);
    })();
    try { await entry.closing; } finally { entry.closing = undefined; }
  }

  async function dispatch(operation: keyof typeof requests, body: unknown): Promise<unknown> {
    switch (operation) {
      case 'workspace.create': {
        const input = requests[operation].parse(body);
        if (creatingWorkspaces.has(input.iid)) throw new HttpFailure(409, 'WORKSPACE_BUSY', 'workspace creation is already in progress');
        creatingWorkspaces.add(input.iid);
        try {
          const existing = await options.sandboxDeps.worktreeManager.get(input.iid);
          if (existing) return { iid: existing.iid, path: await workspace(existing.path), branch: existing.branch };
          const destination = join(root, `issue-${input.iid}`);
          const occupied = await lstat(destination).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
          if (occupied) throw new HttpFailure(409, 'WORKSPACE_EXISTS', 'workspace path already exists');
          const created = await options.sandboxDeps.worktreeManager.create(input.iid, input.baseBranch, root);
          return { iid: created.iid, path: await workspace(created.path), branch: created.branch };
        } finally { creatingWorkspaces.delete(input.iid); }
      }
      case 'sandbox.create': {
        const input = requests[operation].parse(body);
        if (sandboxes.size + creatingSandboxes >= maxSandboxes) throw new HttpFailure(429, 'SANDBOX_LIMIT', 'sandbox limit reached');
        creatingSandboxes++;
        try {
          const path = await workspace(input.worktreePath);
          const value = await provider.create({ ...input, worktreePath: path, workspaceRoot: root, executionMode: 'batch' });
          if (closed) { await value.close(); throw new HttpFailure(503, 'SERVER_CLOSED', 'server is closing'); }
          const id = randomUUID();
          sandboxes.set(id, { sandbox: value, executions: new Map(), busy: false });
          return { id, worktreePath: value.worktreePath, workspacePath: value.workspacePath };
        } finally { creatingSandboxes--; }
      }
      case 'sandbox.close': {
        const { sandboxId } = requests[operation].parse(body);
        await closeSandbox(sandboxId, sandbox(sandboxId));
        return { ok: true };
      }
      case 'agent.start': {
        const input = requests[operation].parse(body);
        const entry = sandbox(input.sandboxId);
        const agent = agents.get(input.options.metadata.provider);
        if (!agent) throw new HttpFailure(403, 'AGENT_DENIED', 'agent provider is not explicitly allowed');
        if (entry.busy || [...entry.executions.values()].some(job => job.state === 'running' || job.state === 'interrupted')) throw new HttpFailure(409, 'AGENT_BUSY', 'sandbox already has an active agent');
        if (entry.executions.size >= maxExecutions) throw new HttpFailure(429, 'EXECUTION_LIMIT', 'execution limit reached');
        entry.busy = true;
        try {
          const start: AgentExecutionOptions = {
            sandbox: entry.sandbox, worktreePath: entry.sandbox.worktreePath, sessionId: randomUUID(),
            generation: input.options.generation, goal: input.options.prompt, prompt: input.options.prompt,
            signalType: 'goal_complete', executionMode: 'batch',
            runtime: input.options.runtime,
          };
          const value = await agent.createExecution(start);
          if (closed || entry.closing || !sandboxes.has(input.sandboxId)) { await value.kill(); throw new HttpFailure(409, 'SANDBOX_CLOSED', 'sandbox closed during agent start'); }
          return register(entry, value, agent, start);
        } finally { entry.busy = false; }
      }
      case 'agent.event.next': {
        const input = requests[operation].parse(body);
        const event = await execution(input).execution.waitForEvent();
        return event?.type === 'error' ? { type: 'error', error: { name: event.error.name, message: event.error.message } } : event;
      }
      case 'agent.wait': {
        const input = requests[operation].parse(body);
        const job = execution(input);
        job.result ??= job.execution.waitForResult({
          ...input.options, completionTimeoutMs: Math.min(input.options?.completionTimeoutMs ?? executionTimeoutMs, executionTimeoutMs),
        }).then(async value => {
          if (value.status !== 'context_high') {
            await job.execution.kill();
            clearTimeout(job.timer);
            if (job.state !== 'superseded') job.state = 'terminal';
          }
          const metadata = { ...job.execution.metadata, provider: job.agent.name };
          if (value.status === 'failed' && !value.sessionId && !metadata.threadId) {
            job.sessionInvalidated = true;
            job.snapshot = undefined;
          }
          if (job.stopReason && value.status !== 'completed') {
            return {
              ...value, provider: job.agent.name, metadata, sessionInvalidated: job.sessionInvalidated ?? false,
              status: job.stopReason === 'timeout' ? 'timed_out' as const : 'aborted' as const,
              ...(job.stopReason === 'timeout' ? {
                error: { code: 'EXECUTION_TIMEOUT', message: 'server execution deadline exceeded' },
                diagnostics: { timeout: { kind: 'hard' as const, budgetMs: executionTimeoutMs } },
              } : {}),
            };
          }
          return { ...value, provider: job.agent.name, metadata, sessionInvalidated: job.sessionInvalidated ?? false };
        }).catch(error => { job.result = undefined; throw error; });
        return job.result;
      }
      case 'agent.output': {
        const input = requests[operation].parse(body);
        return { output: await execution(input).execution.captureOutput(input.options) };
      }
      case 'agent.capture-session': {
        const job = execution(requests[operation].parse(body));
        if (job.sessionInvalidated || !job.agent.capabilities.has('resume')) return null;
        const captured = await job.execution.captureSession() ?? (job.agent.captureSession && job.execution.sessionId
          ? await job.agent.captureSession({ sessionId: job.execution.sessionId, worktreePath: job.options.worktreePath }) : undefined);
        if (job.sessionInvalidated) return null;
        job.snapshot = captured === undefined ? undefined : sessionSchema.parse(JSON.parse(JSON.stringify(captured)));
        return job.snapshot ?? null;
      }
      case 'agent.interrupt':
      case 'agent.kill': {
        const input = requests[operation].parse(body);
        const job = execution(input, operation === 'agent.kill');
        if (operation === 'agent.kill') {
          await job.execution.kill();
          clearTimeout(job.timer);
          job.failure = undefined;
        } else {
          job.stopReason ??= 'interrupt';
          await job.execution.interrupt(requests['agent.interrupt'].parse(body).reason);
        }
        if (job.state !== 'terminal' && job.state !== 'superseded') {
          job.stopReason ??= operation === 'agent.kill' ? 'kill' : 'interrupt';
          job.state = operation === 'agent.kill' ? 'stopped' : 'interrupted';
        }
        return { ok: true };
      }
      case 'agent.resume': {
        const input = requests[operation].parse(body);
        const entry = sandbox(input.sandboxId);
        const job = execution(input);
        if (entry.busy || job.state === 'running' || [...entry.executions.values()].some(value => value !== job && (value.state === 'running' || value.state === 'interrupted'))) throw new HttpFailure(409, 'AGENT_BUSY', 'interrupt or finish the agent before resuming');
        if (!job.agent.capabilities.has('resume')) throw new HttpFailure(409, 'RESUME_UNSUPPORTED', 'agent does not support resume');
        if (!job.snapshot || !isDeepStrictEqual(job.snapshot, input.options.snapshot)) throw new HttpFailure(403, 'SNAPSHOT_DENIED', 'resume requires an unmodified snapshot captured by this execution');
        const snapshot = job.snapshot;
        if (entry.executions.size >= maxExecutions) throw new HttpFailure(429, 'EXECUTION_LIMIT', 'execution limit reached');
        entry.busy = true;
        try {
          await job.execution.kill();
          clearTimeout(job.timer);
          job.state = 'stopped';
          const start = { ...job.options, sessionId: snapshot.sessionId, generation: snapshot.generation + 1, resume: snapshot,
            ...(input.options.prompt !== undefined ? { prompt: input.options.prompt, goal: input.options.prompt } : {}) };
          let value: AgentExecution;
          if (job.agent.restoreSession) {
            await guardedRestoreSession(job.agent, { snapshot, worktreePath: start.worktreePath });
            value = await job.agent.createExecution(start);
          } else value = await job.execution.resume({ snapshot, prompt: input.options.prompt });
          if (closed || entry.closing || !sandboxes.has(input.sandboxId)) { await value.kill(); throw new HttpFailure(409, 'SANDBOX_CLOSED', 'sandbox closed during resume'); }
          clearTimeout(job.timer);
          job.state = 'superseded';
          return register(entry, value, job.agent, start);
        } finally { entry.busy = false; }
      }
    }
  }

  function respond(response: ServerResponse, status: number, value: unknown): void {
    const json = JSON.stringify(value);
    if (json === undefined) throw new Error('remote provider returned an undefined response');
    if (response.destroyed || response.writableEnded) return;
    response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    response.end(json);
  }

  const handle: RequestListener = (request, response) => {
    void (async () => {
      const supplied = createHash('sha256').update(request.headers.authorization ?? '').digest();
      if (!timingSafeEqual(supplied, tokenDigest)) throw new HttpFailure(401, 'UNAUTHORIZED', 'valid bearer authentication is required');
      const peer = request.socket.remoteAddress;
      if (!options.allowRemote && !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(peer ?? '')) throw new HttpFailure(403, 'REMOTE_DENIED', 'non-loopback clients require allowRemote: true');
      if (request.headers.origin) throw new HttpFailure(403, 'ORIGIN_DENIED', 'browser origins are not allowed');
      if (closed) throw new HttpFailure(503, 'SERVER_CLOSED', 'remote container server is closed');
      const route = request.url?.startsWith(basePath) ? request.url.slice(basePath.length) : undefined;
      if (route === 'health') {
        if (request.method !== 'GET') throw new HttpFailure(405, 'METHOD_DENIED', 'health requires GET');
        return respond(response, 200, { healthy: true });
      }
      if (!route || !Object.hasOwn(requests, route)) throw new HttpFailure(404, 'ROUTE_MISSING', 'operation is not allowed');
      if (request.method !== 'POST') throw new HttpFailure(405, 'METHOD_DENIED', 'operations require POST');
      const body = await readBody(request, maxBodyBytes, bodyTimeoutMs);
      if (closed) throw new HttpFailure(503, 'SERVER_CLOSED', 'remote container server is closed');
      const operation = dispatch(route as keyof typeof requests, body);
      if (['workspace.create', 'sandbox.create', 'agent.start', 'agent.resume'].includes(route)) {
        pendingCreations.add(operation);
        void operation.then(() => pendingCreations.delete(operation), () => pendingCreations.delete(operation));
      }
      respond(response, 200, await operation);
    })().catch(error => {
      request.resume();
      const failure = error instanceof HttpFailure ? error : error instanceof z.ZodError
        ? new HttpFailure(400, 'INVALID_PAYLOAD', 'operation payload is invalid')
        : new HttpFailure(500, 'PROVIDER_FAILED', 'remote provider operation failed');
      respond(response, failure.status, { error: { code: failure.code, message: failure.message } });
    });
  };

  return {
    handle,
    async close() {
      closed = true;
      await Promise.allSettled([...pendingCreations]);
      const outcomes = await Promise.allSettled([...sandboxes].map(([id, entry]) => closeSandbox(id, entry)));
      const errors = outcomes.filter((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected');
      if (errors.length) throw new AggregateError(errors.map(error => error.reason), 'remote server cleanup failed');
    },
  };
}
