import { realpath } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import type { AgentExecutionOptions, NativeSessionCheckpoint, RestoreSessionOptions, TokenUsage } from '../types.js';

export const nativeId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export class NativeUsageError extends Error {}

export interface CodexCheckpoint extends NativeSessionCheckpoint {
  transport: 'stdio';
  turnId: string;
  modelProvider: string;
  total: TokenUsage;
}

export function supportsLocalResume(options: Pick<AgentExecutionOptions, 'sandbox' | 'runtime' | 'executionMode' | 'interactive' | 'executionProfile'>): boolean {
  const runtime = options.runtime;
  return runtime?.kind === 'codex' && runtime.transport === 'app-server' && !runtime.profile
    && (runtime.endpoint ?? 'stdio://') === 'stdio://' && options.sandbox.localProcessWorkspace === true
    && !options.sandbox.startProviderExecution && options.executionMode !== 'interactive' && !options.interactive
    && options.executionProfile !== 'analysis';
}

export async function checkedWorkspace(path: string): Promise<string> {
  if (!path || !isAbsolute(path)) throw new Error('Invalid Codex native session workspace');
  return realpath(path);
}

export function validUsage(value: unknown): value is TokenUsage {
  const usage = value as Partial<TokenUsage> | null;
  return !!usage && [usage.inputTokens, usage.outputTokens, usage.totalTokens].every(count => Number.isSafeInteger(count) && count! >= 0);
}

export function resumedUsage(total: unknown, last: unknown, baseline: TokenUsage, previous?: { total: TokenUsage; last: TokenUsage }) {
  if (!validUsage(total) || !validUsage(last)) throw new NativeUsageError('Incomplete native token usage');
  const keys = ['inputTokens', 'outputTokens', 'totalTokens'] as const;
  const duplicate = previous && keys.every(key => total[key] === previous.total[key] && last[key] === previous.last[key]);
  const watermark = previous?.total ?? baseline;
  if (!duplicate && !keys.every(key => total[key] - watermark[key] === last[key])) {
    throw new NativeUsageError('Codex cumulative token watermark mismatch');
  }
  return { total, last, delta: { inputTokens: total.inputTokens - baseline.inputTokens, outputTokens: total.outputTokens - baseline.outputTokens,
    totalTokens: total.totalTokens - baseline.totalTokens } };
}

export async function readCheckpoint({ snapshot, worktreePath }: RestoreSessionOptions): Promise<CodexCheckpoint> {
  const saved = snapshot?.checkpoint as Partial<CodexCheckpoint> | undefined;
  if (saved?.version !== 1 || saved.provider !== 'codex' || saved.transport !== 'stdio'
    || typeof snapshot.sessionId !== 'string' || !nativeId.test(snapshot.sessionId) || saved.sessionId !== snapshot.sessionId
    || typeof saved.turnId !== 'string' || !nativeId.test(saved.turnId) || !Number.isSafeInteger(snapshot.generation) || snapshot.generation < 0
    || typeof saved.modelProvider !== 'string' || !saved.modelProvider || !validUsage(saved.total)
    || saved.workspacePath !== undefined || saved.worktreePath !== await checkedWorkspace(worktreePath)) {
    throw new Error('Invalid Codex native session snapshot');
  }
  return saved as CodexCheckpoint;
}
