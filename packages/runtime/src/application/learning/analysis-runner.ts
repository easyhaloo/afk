import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { constants, lstatSync, promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';
import { aborted } from 'node:util';
import { z } from 'zod';
import type { AgentExecution, AgentProvider, TokenUsage } from '../../domain/agents/types.js';
import { LocalSandbox } from '../../infrastructure/sandbox/providers/local.js';
import { assertAnalysisGuardAvailable, spawnGuardedAnalysis } from '../../infrastructure/sandbox/providers/analysis-process-guard.js';
import { DISTILLATION_LIMITS } from './contracts.js';

const requiredFlags = ['--safe-mode', '--tools', '--permission-mode', '--permission-prompts',
  '--strict-mcp-config', '--mcp-config', '--disable-slash-commands', '--setting-sources',
  '--settings', '--no-session-persistence', '--no-chrome', '--session-id', '--system-prompt'];

async function readGuardedHelp(executable: string, directory: string, signal: AbortSignal): Promise<string> {
  const outputPath = join(directory, 'claude-help');
  const output = await fs.open(outputPath, 'wx+', 0o600);
  try {
    await fs.unlink(outputPath);
    signal.throwIfAborted();
    const probe = spawnGuardedAnalysis([executable, '--help'], { signal, timeout: 10_000, killSignal: 'SIGTERM' }, output.fd);
    try {
      probe.stderr?.resume();
      const [code] = await once(probe, 'close');
      const size = (await output.stat()).size;
      if (code !== 0 || size >= 128 * 1024) throw new Error('analysis_unsupported');
      const bytes = Buffer.alloc(size);
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesRead } = await output.read(bytes, offset, bytes.length - offset, offset);
        if (bytesRead === 0) throw new Error('analysis_unsupported');
        offset += bytesRead;
      }
      return bytes.toString('utf8');
    } finally { probe.kill('SIGTERM'); }
  } finally { await output.close(); }
}

function executableIdentity(path: string): string | undefined {
  const stats = lstatSync(path, { bigint: true, throwIfNoEntry: false });
  if (stats?.isFile()) return [stats.dev, stats.ino, stats.mode, stats.uid, stats.gid, stats.size, stats.mtimeNs, stats.ctimeNs].join(':');
}

async function resolveClaudeExecutable(signal: AbortSignal) {
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    signal.throwIfAborted();
    if (!isAbsolute(directory)) continue;
    try {
      const executable = await fs.realpath(join(directory, 'claude'));
      const identity = executableIdentity(executable);
      if (!identity) continue;
      await fs.access(executable, constants.X_OK);
      return { executable, verifyExecutable() {
        let current: string | undefined;
        try { current = executableIdentity(executable); } catch { /* Cannot establish identity. */ }
        if (current !== identity) throw new Error('analysis_executable_changed');
      } };
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    }
  }
  throw new Error('analysis_unsupported');
}

export interface AnalysisExecutionInput {
  provider: AgentProvider;
  jobId: string;
  prompt: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  onStarted?: (identity: { analysisRunId: string; sessionId: string }) => void | Promise<void>;
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
  assertAnalysisGuardAvailable();
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
    const selected = await resolveClaudeExecutable(controller.signal).catch(() => {
      throw controller.signal.aborted ? cancellationError() : new Error('analysis_unsupported');
    });
    if (controller.signal.aborted) throw cancellationError();
    const analysisRunId = randomUUID();
    const sessionId = randomUUID();
    const recording = input.onStarted?.({ analysisRunId, sessionId });
    if (recording) await Promise.race([recording, aborted(controller.signal, recording)]);
    if (controller.signal.aborted) throw cancellationError();
    selected.verifyExecutable();
    directory = await fs.mkdtemp(join(await fs.realpath(tmpdir()), 'learning-analysis-'));
    if (controller.signal.aborted) throw cancellationError();
    try {
      help = await readGuardedHelp(selected.executable, directory, controller.signal);
    }
    catch { throw controller.signal.aborted ? cancellationError() : new Error('analysis_unsupported'); }
    const supported = new Set(help.match(/--[a-z][a-z0-9-]*/g) ?? []);
    if (requiredFlags.some(flag => !supported.has(flag))) throw new Error('analysis_unsupported');
    if (controller.signal.aborted) throw cancellationError();
    const sandbox = new LocalSandbox({ id: analysisRunId, worktreePath: directory, workspaceRoot: directory,
      sessionName: `learning-${analysisRunId}`, runtimeRunId: analysisRunId, analysis: { ...selected, sessionId } });
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
    if (result.status !== 'completed' || result.tools?.length || execution.metadata.threadId !== sessionId) {
      throw new Error('analysis_failed');
    }
    const bytes = JSON.stringify(result.structuredOutput);
    if (!bytes || Buffer.byteLength(bytes) > DISTILLATION_LIMITS.outputBytes + 128) throw new Error('analysis_output_limit');
    return { analysisRunId, sessionId, output: result.structuredOutput, usage: result.usage };
  } finally {
    clearTimeout(deadline);
    input.signal?.removeEventListener('abort', cancel);
    if (abortExecution) controller.signal.removeEventListener('abort', abortExecution);
    if (execution) await execution.kill();
    if (directory) await fs.rm(directory, { recursive: true, force: true });
  }
}
