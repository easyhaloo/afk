import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import type { AgentExecution, AgentProvider, TokenUsage } from '../../domain/agents/types.js';
import { LocalSandbox } from '../../infrastructure/sandbox/providers/local.js';
import { spawnGuardedAnalysis } from '../../infrastructure/sandbox/providers/analysis-process-guard.js';
import { DISTILLATION_LIMITS } from './contracts.js';

const requiredFlags = ['--safe-mode', '--tools', '--permission-mode', '--permission-prompts',
  '--strict-mcp-config', '--mcp-config', '--disable-slash-commands', '--setting-sources',
  '--settings', '--no-session-persistence', '--no-chrome', '--session-id', '--system-prompt'];

export interface AnalysisExecutionInput {
  provider: AgentProvider;
  jobId: string;
  prompt: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  onStarted?: (identity: { analysisRunId: string; sessionId: string }) => void;
}

export interface AnalysisExecutionResult {
  analysisRunId: string;
  sessionId?: string;
  output: unknown;
  usage?: TokenUsage;
}

export async function executeAnalysis(input: AnalysisExecutionInput): Promise<AnalysisExecutionResult> {
  z.string().trim().min(1).max(512).refine(value => !/[\0\r\n\t]/.test(value)).parse(input.jobId);
  z.string().min(1).refine(value => Buffer.byteLength(value) <= 256 * 1024, 'Analysis prompt exceeds byte limit').parse(input.prompt);
  const timeoutMs = z.number().int().positive().max(120_000).parse(input.timeoutMs ?? DISTILLATION_LIMITS.timeoutMs);
  if (!input.provider.capabilities.has('analysis') || input.provider.name !== 'claude-code') throw new Error('analysis_unsupported');
  if (input.signal?.aborted) throw new Error('analysis_cancelled');
  const controller = new AbortController();
  let timedOut = false;
  const deadline = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  const cancel = () => controller.abort();
  input.signal?.addEventListener('abort', cancel, { once: true });
  let directory: string | undefined;
  let execution: AgentExecution | undefined;
  let abortExecution: (() => void) | undefined;
  const cancellationError = () => new Error(timedOut ? 'analysis_timed_out' : 'analysis_cancelled');
  try {
    let help: string;
    try {
      const probe = spawnGuardedAnalysis(['claude', '--help'], { signal: controller.signal, timeout: 10_000, killSignal: 'SIGTERM' });
      try {
        help = await new Promise<string>((resolve, reject) => {
          let output = '';
          probe.stdout?.on('data', (chunk: Buffer) => {
            if (Buffer.byteLength(output) + chunk.length > 128 * 1024) {
              probe.kill('SIGTERM');
              reject(new Error('analysis_unsupported'));
            } else output += chunk.toString();
          });
          probe.stderr?.resume();
          probe.on('error', reject);
          probe.on('close', code => code === 0 ? resolve(output) : reject(new Error('analysis_unsupported')));
        });
      } finally { probe.kill('SIGTERM'); }
    }
    catch { throw controller.signal.aborted ? cancellationError() : new Error('analysis_unsupported'); }
    const supported = new Set(help.match(/--[a-z][a-z0-9-]*/g) ?? []);
    if (requiredFlags.some(flag => !supported.has(flag))) throw new Error('analysis_unsupported');
    if (controller.signal.aborted) throw cancellationError();
    directory = await fs.mkdtemp(join(await fs.realpath(tmpdir()), 'learning-analysis-'));
    if (controller.signal.aborted) throw cancellationError();
    const analysisRunId = randomUUID();
    const sessionId = randomUUID();
    const sandbox = new LocalSandbox({ id: analysisRunId, worktreePath: directory, workspaceRoot: directory,
      sessionName: `learning-${analysisRunId}`, runtimeRunId: analysisRunId, analysisParentGuard: true });
    input.onStarted?.({ analysisRunId, sessionId });
    if (controller.signal.aborted) throw cancellationError();
    execution = await input.provider.createExecution({ sandbox, worktreePath: directory, sessionId,
      prompt: input.prompt, signalType: 'goal_complete', generation: 1,
      executionMode: 'batch', executionProfile: 'analysis' });
    const cancelled = new Promise<never>((_resolve, reject) => {
      abortExecution = () => {
        void execution!.interrupt('manual').catch(() => {});
        reject(cancellationError());
      };
      controller.signal.addEventListener('abort', abortExecution, { once: true });
      if (controller.signal.aborted) abortExecution();
    });
    const result = await Promise.race([execution.waitForResult({ completionTimeoutMs: timeoutMs }), cancelled]);
    if (controller.signal.aborted) throw cancellationError();
    if (result.status !== 'completed' || result.tools?.length) throw new Error('analysis_failed');
    const bytes = JSON.stringify(result.structuredOutput);
    if (!bytes || Buffer.byteLength(bytes) > DISTILLATION_LIMITS.outputBytes + 128) throw new Error('analysis_output_limit');
    return { analysisRunId, sessionId: execution.metadata.threadId ?? result.sessionId,
      output: result.structuredOutput, usage: result.usage };
  } finally {
    clearTimeout(deadline);
    input.signal?.removeEventListener('abort', cancel);
    if (abortExecution) controller.signal.removeEventListener('abort', abortExecution);
    if (execution) await execution.kill();
    if (directory) await fs.rm(directory, { recursive: true, force: true });
  }
}
