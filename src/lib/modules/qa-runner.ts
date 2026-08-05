import { promises as fs } from 'fs';
import { WorktreeManager } from '../core/git';
import { createTmuxClient, type TmuxClient } from '../core/tmux';
import { configureStatusline, logger } from '../io';
import { getWorkflowConfig } from '../core/config/manager';
import { TemplateLoader } from '../templates/loader';
import { compileTemplate } from '../templates/compiler';
import { createAgentProvider } from '../agents';
import { createSandboxProvider } from '../sandbox';
import type { AgentProvider, ExecutionMode } from '../agents/types';
import type { AgentExecution, Sandbox, SandboxProvider, ExecutionResult } from '../sandbox/types';
import type { ManagementProviderBundle } from '../core/providers';
import type { WorkflowConfig } from '../core/config/manager';
import type { BacklogItem } from '../core/backlog';
import { formatExecutionFailure } from '../workflows';
import { buildExecutionPrompt } from '../workflows/execution-protocol';
import { TaskRuntimeManager } from '../runtime/task-runtime';

export interface QARunnerDependencies {
  sandboxProvider?: SandboxProvider;
  agentProvider?: AgentProvider;
  tmux?: TmuxClient;
  executionMode?: ExecutionMode;
  projectRoot?: string;
  mergeBranch?: (worktreePath: string, branch: string) => Promise<void>;
  runtimeManager?: TaskRuntimeManager;
}

/**
 * QA worker for items in verification.
 *
 * QA owns the verification workflow, but not the execution transport. The
 * sandbox creates either a batch AgentExecution or an interactive tmux-backed
 * AgentExecution. This runner only builds the provider command, waits for the
 * typed result, and routes the backlog state.
 */
export class QARunner {
  private readonly logDir: string;
  private readonly config: WorkflowConfig;
  private readonly providers: ManagementProviderBundle;
  private readonly sandboxProvider: SandboxProvider;
  private readonly agentProvider: AgentProvider;
  private readonly tmux?: TmuxClient;
  private readonly executionMode: ExecutionMode;
  private readonly projectRoot: string;
  private readonly mergeBranchOverride?: (worktreePath: string, branch: string) => Promise<void>;
  private readonly runtimeManager: TaskRuntimeManager;

  constructor(providers: ManagementProviderBundle, config?: WorkflowConfig, deps: QARunnerDependencies = {}) {
    this.logDir = `${process.env.HOME}/.claude/logs/afk/qa`;
    this.config = config ?? getWorkflowConfig();
    this.providers = providers;
    this.executionMode = deps.executionMode ?? 'batch';
    this.projectRoot = deps.projectRoot ?? process.cwd();
    this.mergeBranchOverride = deps.mergeBranch;
    this.runtimeManager = deps.runtimeManager ?? new TaskRuntimeManager();
    this.sandboxProvider = deps.sandboxProvider ?? createSandboxProvider('local', { worktreeManager: new WorktreeManager() });
    this.agentProvider = deps.agentProvider ?? createAgentProvider('claude-code');
    this.tmux = deps.tmux ?? (this.executionMode === 'interactive' ? createTmuxClient() : undefined);
  }

  async process(backlogId: string): Promise<{ success: boolean; mrUrl?: string }> {
    const id = String(backlogId);
    logger.info({ backlogId: id, executionMode: this.executionMode }, 'QA processing started');

    const backlog = await this.providers.backlog.get(id);
    const baselineBranch = this.config.targetBranch ?? 'main';
    const session = `qa-${id}-${Date.now()}`;
    let worktreePath: string | undefined;
    let sandbox: Sandbox | undefined;
    let execution: AgentExecution | undefined;
    const runtimeRunId = `${session}-runtime`;
    let runtimeStarted = false;
    let runtimeErrorSummary: string | undefined;

    try {
      await this.startRuntime(runtimeRunId, backlog, session);
      runtimeStarted = true;
      const handle = await this.providers.branches.createVerificationWorktree(backlog, baselineBranch);
      worktreePath = handle.worktreePath;
      await this.heartbeatRuntime(runtimeRunId, { worktree: worktreePath, branch: handle.branchName, progress: 'QA worktree created' });
      if (this.executionMode === 'interactive') await configureStatusline(worktreePath);
      logger.info({ backlogId: id, worktree: worktreePath, baselineBranch }, 'QA worktree created');

      const featureBranch = backlog.branchName;
      if (!featureBranch) {
        await this.markBlocked(id, 'feature branch could not be resolved');
        return { success: false };
      }
      if (this.mergeBranchOverride) await this.mergeBranchOverride(worktreePath, featureBranch);
      else await this.mergeBranch(worktreePath, featureBranch);

      const qaTemplate = await new TemplateLoader({ projectRoot: this.projectRoot }).load('pre-merge-qa-verification');
      const qaStep = compileTemplate(qaTemplate).groups
        .flatMap(group => group.steps)
        .find(step => step.kind === 'agent');
      if (!qaStep || typeof qaStep.prompt !== 'string') {
        throw new Error('pre-merge-qa-verification template must contain an inline agent prompt');
      }

      sandbox = await this.sandboxProvider.create({
        worktreePath,
        session,
        branch: handle.branchName,
        executionMode: this.executionMode,
        tmux: this.executionMode === 'interactive' ? this.tmux : undefined,
      });
      logger.info({ backlogId: id, session, sandboxId: sandbox.id }, 'QA sandbox created');

      const prompt = buildExecutionPrompt(qaStep.prompt.replaceAll('{iid}', id), this.executionMode, 'qa');
      const command = this.agentProvider.buildCommand({
        worktreePath,
        sessionId: session,
        executionMode: this.executionMode,
      });
      execution = await sandbox.startAgent({
        command,
        generation: 1,
        prompt,
        signalType: 'goal_complete',
        executionMode: this.executionMode,
        agentProvider: this.agentProvider,
      });
      await this.heartbeatRuntime(runtimeRunId, { progress: 'QA agent running' });
      logger.info({ backlogId: id, session, event: 'qa-start' }, 'QA verification started');

      const result = await execution.waitForResult({ completionTimeoutMs: this.config.completionTimeout });
      await this.writeRuntimeDiagnostics(runtimeRunId, result, execution);
      logger.info({ backlogId: id, diagnostics: formatExecutionFailure(result) }, 'QA execution result received');
      if (result.status !== 'completed') {
        runtimeErrorSummary = formatExecutionFailure(result);
        await this.handleExecutionFailure(id, worktreePath, session, result, execution);
        return { success: false };
      }

      const signal = asQAResult(result.structuredOutput);
      if (!signal) {
        runtimeErrorSummary = `${formatExecutionFailure(result)}; missing QA completion payload`;
        await this.markBlocked(id, `${formatExecutionFailure(result)}; missing QA completion payload`);
        return { success: false };
      }
      const outcome = await this.handleACResult(id, signal);
      if (!outcome.success) {
        runtimeErrorSummary = signal.result === 'PASS'
          ? 'QA terminal routing failed'
          : 'QA did not return goal_complete kind=qa result=PASS';
      }
      return outcome;
    } catch (error) {
      const message = `QA execution failed: ${(error as Error).message}`;
      runtimeErrorSummary = message;
      await this.markBlocked(id, message);
      logger.error({ backlogId: id, error }, 'QA execution failed');
      return { success: false };
    } finally {
      if (execution) await execution.kill().catch(() => {});
      if (sandbox) await sandbox.close().catch(error => logger.warn({ backlogId: id, error }, 'failed to close QA sandbox'));
      if (worktreePath) {
        try {
          await this.providers.branches.cleanup(worktreePath, { preserve: false });
        } catch (error) {
          logger.warn({ backlogId: id, error }, 'failed to clean QA worktree');
        }
      }
      if (runtimeStarted) {
        await this.finishRuntime(runtimeRunId, runtimeErrorSummary ? 'blocked' : 'completed', runtimeErrorSummary);
      }
    }
  }

  private async mergeBranch(worktreePath: string, branch: string): Promise<void> {
    const { simpleGit } = await import('simple-git');
    const git = simpleGit(worktreePath);
    try { await git.fetch('origin', branch); } catch { /* branch may be local only */ }
    await git.merge([branch]);
    logger.info({ worktreePath, branch }, 'branch merged successfully');
  }

  private async handleExecutionFailure(
    backlogId: string,
    worktreePath: string,
    session: string,
    result: ExecutionResult,
    execution: AgentExecution,
  ): Promise<void> {
    if (result.status === 'timed_out') {
      const snapshot = await execution.captureOutput({ lines: 100, history: 200 });
      await fs.mkdir(this.logDir, { recursive: true });
      await fs.writeFile(`${this.logDir}/timeout-${backlogId}-${Date.now()}.log`, snapshot, 'utf-8');
    }
    await this.markBlocked(backlogId, `QA ${result.status}: ${formatExecutionFailure(result)}`);
    logger.warn({ backlogId, session, worktreePath, diagnostics: formatExecutionFailure(result) }, 'QA execution did not complete');
  }

  private async handleACResult(
    backlogId: string,
    signal: { type: 'goal_complete'; kind: 'qa'; summary?: string; result?: string },
  ): Promise<{ success: boolean; mrUrl?: string }> {
    if (signal.result !== 'PASS') {
      await this.markBlocked(backlogId, 'QA did not return goal_complete kind=qa result=PASS');
      return { success: false };
    }

    const backlog = await this.providers.backlog.get(backlogId);
    const mr = await this.providers.changes.findForBacklog(backlog);
    if (!mr) {
      await this.markBlocked(backlogId, 'change request not found');
      logger.warn({ backlogId }, 'QA failed: change request not found');
      return { success: false };
    }

    try {
      await this.providers.backlog.transition(backlogId, 'merge_ready', { changeId: String(mr.id) });
      await this.providers.changes.merge(String(mr.id));
      await this.providers.backlog.transition(backlogId, 'done', { changeId: String(mr.id) });
      logger.info({ backlogId, changeId: mr.id }, 'change merged');
      return { success: true, mrUrl: mr.url };
    } catch (error) {
      await this.markBlocked(backlogId, `change merge failed: ${(error as Error).message}`);
      logger.error({ backlogId, changeId: mr.id, error }, 'QA failed: change merge error');
      return { success: false };
    }
  }

  private async markBlocked(backlogId: string, reason: string): Promise<void> {
    await this.providers.backlog.transition(backlogId, 'blocked', { reason });
    await this.providers.backlog.setExecutionMode(backlogId, 'hitl');
  }

  private async startRuntime(runId: string, backlog: BacklogItem, session: string): Promise<void> {
    const now = new Date().toISOString();
    try {
      await this.runtimeManager.start({
        runId,
        backlogId: backlog.id,
        title: backlog.title,
        phase: 'verifying',
        status: 'running',
        sandboxProvider: this.sandboxProvider.name,
        executionMode: this.executionMode,
        agentProvider: this.agentProvider.name,
        session: this.executionMode === 'interactive' ? session : undefined,
        branch: backlog.branchName,
        startedAt: now,
        heartbeatAt: now,
        progress: 'QA starting',
      });
    } catch (error) {
      logger.warn({ backlogId: backlog.id, error }, 'failed to publish QA runtime');
    }
  }

  private async heartbeatRuntime(runId: string, changes: Parameters<TaskRuntimeManager['heartbeat']>[1]): Promise<void> {
    try {
      await this.runtimeManager.heartbeat(runId, changes);
    } catch (error) {
      logger.warn({ runId, error }, 'failed to update QA runtime');
    }
  }

  private async finishRuntime(runId: string, status: 'completed' | 'blocked', errorSummary?: string): Promise<void> {
    try {
      await this.runtimeManager.finish(runId, {
        status,
        progress: status === 'completed' ? 'QA completed' : 'QA stopped',
        errorSummary,
      });
    } catch (error) {
      logger.warn({ runId, error }, 'failed to archive QA runtime');
    }
  }

  private async writeRuntimeDiagnostics(runId: string, result: ExecutionResult, execution: AgentExecution): Promise<void> {
    try {
      const output = await execution.captureOutput({ lines: 200, history: 2_000 });
      await this.runtimeManager.writeDiagnostics(runId, { result, output });
    } catch (error) {
      logger.warn({ runId, error }, 'failed to persist QA runtime diagnostics');
    }
  }
}

function asQAResult(value: unknown): { type: 'goal_complete'; kind: 'qa'; summary?: string; result?: string } | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = value as { type?: unknown; kind?: unknown; summary?: unknown; result?: unknown };
  if (candidate.type !== 'goal_complete' || candidate.kind !== 'qa') return undefined;
  return {
    type: 'goal_complete',
    kind: 'qa',
    summary: typeof candidate.summary === 'string' ? candidate.summary : undefined,
    result: typeof candidate.result === 'string' ? candidate.result : undefined,
  };
}
