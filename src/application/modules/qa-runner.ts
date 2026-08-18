import { promises as fs } from 'fs';
import { WorktreeManager } from '../../infrastructure/git/index';
import { captureWorktreeDiagnostics } from '../../infrastructure/git/worktree-diagnostics';
import { createTmuxClient, type TmuxClient } from '../../infrastructure/tmux/index';
import { configureStatusline, logger } from '../../infrastructure/io/index';
import { getWorkflowConfig } from '../../infrastructure/config/manager';
import { TemplateLoader } from '../../domain/templates/loader';
import { compileTemplate } from '../../domain/templates/compiler';
import { createAgentProvider } from '../../domain/agents/index';
import { createSandboxProvider } from '../../infrastructure/sandbox/index';
import type { AgentProvider, ExecutionMode } from '../../domain/agents/types';
import type { AgentExecution, Sandbox, SandboxProvider, ExecutionResult } from '../../infrastructure/sandbox/types';
import type { ManagementProviderBundle } from '../providers';
import type { WorkflowConfig } from '../../infrastructure/config/manager';
import type { BacklogItem } from '../../domain/backlog/index';
import type { NewReworkRecord } from '../../domain/backlog/index';
import { formatExecutionFailure } from '../workflow-engine';
import { buildExecutionPrompt } from '../workflows/execution-protocol';
import { TaskRuntimeManager } from '../runtime/task-runtime';

export interface QARunnerDependencies {
  sandboxProvider?: SandboxProvider;
  agentProvider?: AgentProvider;
  tmux?: TmuxClient;
  executionMode?: ExecutionMode;
  projectRoot?: string;
  mergeBranch?: (worktreePath: string, baselineBranch: string, featureBranch: string) => Promise<void>;
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
  private readonly mergeBranchOverride?: (worktreePath: string, baselineBranch: string, featureBranch: string) => Promise<void>;
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

  async process(backlogId: string): Promise<{ success: boolean; mrUrl?: string; autoMerged?: boolean; rework?: boolean }> {
    const id = String(backlogId);
    logger.info({ backlogId: id, executionMode: this.executionMode }, 'QA processing started');

    const backlog = await this.providers.backlog.get(id);
    const parent = backlog.parentId ? await this.providers.backlog.get(backlog.parentId) : undefined;
    const baselineBranch = parent?.branchName ?? this.config.targetBranch ?? 'main';
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
      await this.logWorktreeDiagnostics(id, 'worktree-created', worktreePath);
      await this.heartbeatRuntime(runtimeRunId, { worktree: worktreePath, branch: handle.branchName, progress: 'QA worktree created' });
      logger.info({ backlogId: id, worktree: worktreePath, baselineBranch }, 'QA worktree created');

      const featureBranch = backlog.branchName;
      if (!featureBranch) {
        await this.markBlocked(id, 'feature branch could not be resolved');
        return { success: false };
      }
      if (this.mergeBranchOverride) await this.mergeBranchOverride(worktreePath, baselineBranch, featureBranch);
      else await this.mergeBranch(worktreePath, baselineBranch, featureBranch);
      await this.logWorktreeDiagnostics(id, 'branches-merged', worktreePath);
      if (this.executionMode === 'interactive') {
        await configureStatusline(worktreePath);
        await this.logWorktreeDiagnostics(id, 'statusline-configured', worktreePath);
      }

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
      await this.logWorktreeDiagnostics(id, 'before-agent-start', worktreePath);

      const description = backlog.description?.trim();
      const goal = `${qaStep.prompt.replaceAll('{iid}', id)}\n\nBacklog title: ${backlog.title}${description ? `\nBacklog description:\n${description}` : ''}`;
      const prompt = buildExecutionPrompt(goal, this.executionMode, 'qa');
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
      await this.logWorktreeDiagnostics(id, 'agent-completed', worktreePath);
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
      const outcome = await this.handleQAResult(id, signal, worktreePath, handle.branchName);
      if (!outcome.success) {
        runtimeErrorSummary = signal.result === 'PASS'
          ? 'QA terminal routing failed'
          : signal.summary;
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

  private async mergeBranch(worktreePath: string, baselineBranch: string, featureBranch: string): Promise<void> {
    const { simpleGit } = await import('simple-git');
    const git = simpleGit(worktreePath);
    // Fetch all remote refs before resolving origin/<branch>; a single-branch
    // fetch only guarantees FETCH_HEAD in some Git configurations.
    await git.fetch('origin');
    await git.reset(['--hard', `origin/${baselineBranch}`]);
    await git.merge([`origin/${featureBranch}`, '--no-commit', '--no-ff']);
    logger.info({ worktreePath, baselineBranch, featureBranch }, 'latest baseline and feature merged successfully');
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

  private async handleQAResult(
    backlogId: string,
    signal: QAResult,
    worktreePath: string,
    verificationBranch: string,
  ): Promise<{ success: boolean; mrUrl?: string; autoMerged?: boolean; rework?: boolean }> {
    if (signal.result === 'FAIL') return this.routeQARework(backlogId, signal as QAFailure);

    try {
      const backlog = await this.providers.backlog.get(backlogId);
      const activeRework = await this.providers.backlog.getActiveRework(backlogId);
      const parent = backlog.parentId ? await this.providers.backlog.get(backlog.parentId) : undefined;
      const targetBranch = parent?.branchName ?? this.config.targetBranch ?? 'main';
      await this.providers.branches.commit(worktreePath, `QA: verify backlog ${backlogId}`);
      await this.providers.branches.push(verificationBranch, worktreePath);
      const mr = await this.providers.changes.create({
        backlog,
        sourceBranch: verificationBranch,
        targetBranch,
        draft: false,
      });
      if (activeRework) {
        await this.providers.backlog.resolveRework(backlogId, activeRework.id, {
          summary: `QA passed after rework ${activeRework.id}.`,
        });
      }
      await this.providers.backlog.transition(backlogId, 'merge_ready', { changeId: String(mr.id) });
      if (!backlog.parentId) {
        await this.providers.backlog.setExecutionMode(backlogId, 'hitl');
        logger.info({ backlogId, changeId: mr.id }, 'root backlog QA passed; awaiting human merge');
        return { success: true, autoMerged: false, mrUrl: mr.url };
      }
      await this.providers.changes.merge(String(mr.id));
      await this.providers.backlog.transition(backlogId, 'done', { changeId: String(mr.id) });
      logger.info({ backlogId, changeId: mr.id, targetBranch }, 'child backlog change merged');
      return { success: true, autoMerged: true, mrUrl: mr.url };
    } catch (error) {
      await this.markBlocked(backlogId, `QA terminal routing failed: ${(error as Error).message}`);
      logger.error({ backlogId, error }, 'QA failed: terminal routing error');
      return { success: false };
    }
  }

  private async routeQARework(backlogId: string, signal: QAFailure): Promise<{ success: false; rework: true }> {
    const active = await this.providers.backlog.getActiveRework(backlogId);
    if (active) {
      await this.providers.backlog.transition(backlogId, 'rework', { reason: `QA rework ${active.id} remains open: ${signal.summary}` });
      await this.providers.backlog.setExecutionMode(backlogId, 'afk');
      logger.info({ backlogId, reworkId: active.id }, 'QA failure retained active rework record');
      return { success: false, rework: true };
    }
    const record: NewReworkRecord = {
      source: 'qa',
      summary: signal.summary,
      failedCriteria: signal.failedCriteria,
      requiredChecks: signal.requiredChecks ?? [],
    };
    await this.providers.backlog.createRework(backlogId, record);
    logger.info({ backlogId }, 'QA failure created rework record');
    return { success: false, rework: true };
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
      const structured = result.structuredOutput as { result?: string; summary?: string } | undefined;
      const failed = result.status !== 'completed' || structured?.result === 'FAIL';
      await this.runtimeManager.appendActivity(runId, {
        kind: failed ? 'error' : 'qa',
        message: structured?.summary ?? (failed ? 'QA execution failed' : 'QA execution completed'),
      });
    } catch (error) {
      logger.warn({ runId, error }, 'failed to persist QA runtime diagnostics');
    }
  }

  private async logWorktreeDiagnostics(backlogId: string, phase: string, worktreePath: string): Promise<void> {
    try {
      const diagnostics = await captureWorktreeDiagnostics(worktreePath);
      logger.info({ backlogId, phase, worktreePath, diagnostics }, 'QA worktree diagnostics');
    } catch (error) {
      logger.warn({ backlogId, phase, worktreePath, error }, 'failed to collect QA worktree diagnostics');
    }
  }
}

interface CriteriaCandidate { id?: unknown; expected?: unknown; actual?: unknown }
interface CheckCandidate { command?: unknown; expected?: unknown }
interface QAResultCandidate { type?: unknown; kind?: unknown; result?: unknown; summary?: unknown; requiredChecks?: unknown; failedCriteria?: unknown }

interface QAResult {
  type: 'goal_complete';
  kind: 'qa';
  result: 'PASS' | 'FAIL';
  summary: string;
  failedCriteria?: Array<{ id: string; expected: string; actual: string }>;
  requiredChecks?: Array<{ command: string; expected: string }>;
}

interface QAFailure extends QAResult {
  result: 'FAIL';
  failedCriteria: Array<{ id: string; expected: string; actual: string }>;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function parseCriteria(value: unknown): Array<{ id: string; expected: string; actual: string }> | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const criteria = value.map(entry => {
    if (!entry || typeof entry !== 'object') return undefined;
    const item = entry as CriteriaCandidate;
    return nonEmptyString(item.id) && nonEmptyString(item.expected) && nonEmptyString(item.actual)
      ? { id: item.id, expected: item.expected, actual: item.actual }
      : undefined;
  });
  return criteria.some(item => item === undefined) ? undefined : criteria as Array<{ id: string; expected: string; actual: string }>;
}

function parseRequiredChecks(value: unknown): Array<{ command: string; expected: string }> | undefined {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return undefined;
  const checks = value.map(entry => {
    if (!entry || typeof entry !== 'object') return undefined;
    const item = entry as CheckCandidate;
    return nonEmptyString(item.command) && nonEmptyString(item.expected)
      ? { command: item.command, expected: item.expected }
      : undefined;
  });
  return checks.some(item => item === undefined) ? undefined : checks as Array<{ command: string; expected: string }>;
}

function asQAResult(value: unknown): QAResult | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = value as QAResultCandidate;
  if (
    candidate.type !== 'goal_complete' || candidate.kind !== 'qa' || !nonEmptyString(candidate.summary) ||
    (candidate.result !== 'PASS' && candidate.result !== 'FAIL')
  ) return undefined;
  const requiredChecks = parseRequiredChecks(candidate.requiredChecks);
  if (!requiredChecks) return undefined;
  if (candidate.result === 'FAIL') {
    const failedCriteria = parseCriteria(candidate.failedCriteria);
    if (!failedCriteria) return undefined;
    return { type: 'goal_complete', kind: 'qa', result: 'FAIL', summary: candidate.summary, failedCriteria, requiredChecks };
  }
  return { type: 'goal_complete', kind: 'qa', result: 'PASS', summary: candidate.summary, requiredChecks };
}
