import { workspaceDataDirectory } from '../../infrastructure/workspace.js';
import { describe, expect, it, vi, beforeAll, afterAll } from 'vitest';
import { QARunner } from './qa-runner.js';
import { createAgentProvider, registerAgentProvider } from '../../domain/agents/index.js';
import { TrackerBacklogProvider } from '../../domain/backlog/tracker-provider.js';
import { retryBacklog } from '../../domain/backlog/commands.js';
import { parseReworkRecord } from '../../domain/backlog/rework-record.js';
import type { TrackedIssue, TrackerProvider } from '../../domain/tracker/types.js';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BudgetStore } from '../workflows/budget-store.js';
import { getLogContext, withLogContext } from '../../infrastructure/io/index.js';
import { PluginRuntime } from '../plugins/runtime.js';
import { createDefaultPluginRuntime } from '../plugins/default-runtime.js';
import { createLearningPlugin } from '../plugins/learning.js';
import type { LifecycleContext, LifecycleModule } from '../workflows/lifecycle.js';
import type { Step } from '../../domain/templates/types.js';
import type { ContextQuery } from '../../plugin-sdk/capabilities.js';

const ioMocks = vi.hoisted(() => ({ configureStatusline: vi.fn(async () => {}) }));
vi.mock('../../infrastructure/io/index.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../infrastructure/io/index.js')>(),
  configureStatusline: ioMocks.configureStatusline,
}));

/**
 * The QA worktree.
 *
 * It is a temporary directory, because the runner writes the backlog
 * context into it — the repository under test must not collect it.
 */
let worktreePath = '';
beforeAll(async () => {
  worktreePath = await mkdtemp(join(tmpdir(), 'afk-qa-worktree-'));
});
afterAll(async () => {
  await rm(worktreePath, { recursive: true, force: true });
});

const config = {
  targetBranch: 'main',
  completionTimeout: 1000,
  qaTimeout: 2000,
  contextThreshold: 100_000,
  maxQaReworkAttempts: 3,
} as any;

function fixture() {
  const item = {
    id: '60',
    title: 'search mode',
    description: 'support /s',
    dependsOn: [],
    state: 'verification',
    executionMode: 'afk',
    tags: [],
    branchName: 'afk/backlog-60',
    providerRef: '60',
  };
  const backlog = {
    get: vi.fn(async () => ({ ...item })),
    transition: vi.fn(async () => {}),
    setExecutionMode: vi.fn(async () => {}),
    getActiveRework: vi.fn(async () => undefined),
    createRework: vi.fn(async () => ({ id: 'r1-1', cycle: 1, attempt: 1 })),
    resolveRework: vi.fn(async () => {}),
  };
  const changes = {
    findForBacklog: vi.fn(async () => null),
    create: vi.fn(async ({ sourceBranch, targetBranch }: any) => ({ id: 'pr-60', sourceBranch, targetBranch, url: 'https://example.test/pr/60', mergeState: 'mergeable' })),
    get: vi.fn(async () => ({ id: 'pr-60', state: 'open', sourceBranch: 'qa-60', targetBranch: 'main', mergeState: 'mergeable', url: 'https://example.test/pr/60' })),
    merge: vi.fn(async () => {}),
  };
  const branches = {
    createVerificationWorktree: vi.fn(async () => ({ branchName: 'qa-60', worktreePath: worktreePath })),
    commit: vi.fn(async () => ({ sha: 'commit-60', skippedBinaryFiles: [] })),
    mergeFeatureIntoBaseline: vi.fn(async () => ({ merged: true, conflicts: [] })),
    listUnresolvedConflicts: vi.fn(async () => []),
    push: vi.fn(async () => {}),
    cleanup: vi.fn(async () => {}),
  };
  const execution = {
    id: 'execution-60',
    metadata: { provider: 'claude-code', transport: 'process' },
    waitForEvent: vi.fn(async () => null),
    waitForResult: vi.fn(async () => ({
      version: 1,
      runId: 'execution-60',
      status: 'completed',
      provider: 'batch',
      structuredOutput: { type: 'goal_complete', kind: 'qa', result: 'PASS', summary: 'all integration checks passed' },
      commits: [],
    })),
    interrupt: vi.fn(async () => {}),
    kill: vi.fn(async () => {}),
    captureOutput: vi.fn(async () => ''),
    captureSession: vi.fn(async () => undefined),
    resume: vi.fn(),
  };
  const sandbox = {
    id: 'sandbox-60',
    worktreePath: worktreePath,
    workspacePath: process.cwd(),
    startAgent: vi.fn(async () => execution),
    close: vi.fn(async () => {}),
  };
  const sandboxProvider = { create: vi.fn(async () => sandbox) };
  const agentProvider = {
    name: 'claude-code',
    capabilities: new Set(['streaming', 'structured-output']),
    createExecution: vi.fn(async () => execution),
  };
  return { providers: { backlog, changes, branches } as any, changes, branches, sandboxProvider: sandboxProvider as any, agentProvider: agentProvider as any, sandbox, execution };
}

describe.each(['pre-merge-qa-verification', 'merge-conflict-resolution'])('QARunner specialized template %s', templateName => {
  const reviewer: Step = { id: 'reviewer', kind: 'agent', role: 'reviewer', prompt: 'Review the change and report PASS.' };
  const secondReviewer: Step = { id: 'second-reviewer', kind: 'agent', role: 'reviewer', prompt: 'Report FAIL for the required second review.', dependsOn: ['reviewer'] };
  const systemStep: Step = { id: 'publish', kind: 'system', action: 'publish-change' };
  const unsupported: Array<{ shape: string; steps: Step[] }> = [
    { shape: 'two required reviewers', steps: [reviewer, secondReviewer] },
    { shape: 'two parallel reviewers', steps: [{ ...reviewer, parallel: 'reviews' }, { ...secondReviewer, dependsOn: [], parallel: 'reviews' }] },
    { shape: 'a system step', steps: [systemStep] },
    { shape: 'an agent followed by a required system step', steps: [reviewer, { ...systemStep, dependsOn: ['reviewer'] }] },
    { shape: 'a file prompt', steps: [{ ...reviewer, prompt: { file: join(tmpdir(), 'afk-specialized-review.md') } }] },
  ];

  it.each(unsupported)('rejects $shape before starting any agent or publishing', async ({ steps }) => {
    const current = fixture();
    const secondExecution = {
      ...current.execution,
      waitForResult: vi.fn(async () => ({
        version: 1, runId: 'second-review', status: 'completed', provider: 'batch', commits: [],
        structuredOutput: { type: 'goal_complete', kind: 'qa', result: 'FAIL', summary: 'required second review failed' },
      })),
    };
    current.agentProvider.createExecution = vi.fn()
      .mockResolvedValueOnce(current.execution)
      .mockResolvedValueOnce(secondExecution);
    if (templateName === 'merge-conflict-resolution') {
      current.providers.branches.mergeFeatureIntoBaseline.mockResolvedValue({ merged: false, conflicts: ['shared.txt'] });
    }
    const plugins = new PluginRuntime();
    await plugins.activate({
      id: 'specialized-template', version: '1.0.0',
      setup(context) { context.registerWorkflowTemplate({ name: templateName, version: 1, steps }); },
    });
    try {
      const runner = new QARunner(current.providers, config, {
        plugins, sandboxProvider: current.sandboxProvider, agentProvider: current.agentProvider, executionMode: 'batch',
      });

      expect(await runner.process('60')).toMatchObject({
        success: false,
        failureCode: 'qa_execution_failed',
        summary: expect.stringContaining(`${templateName} template must contain exactly one inline agent step`),
      });
      expect(current.agentProvider.createExecution).not.toHaveBeenCalled();
      expect(current.sandbox.startAgent).not.toHaveBeenCalled();
      expect(current.branches.commit).not.toHaveBeenCalled();
      expect(current.branches.push).not.toHaveBeenCalled();
      expect(current.changes.create).not.toHaveBeenCalled();
      expect(current.changes.merge).not.toHaveBeenCalled();
      expect(current.providers.backlog.transition).not.toHaveBeenCalledWith('60', 'merge_ready', expect.anything());
      expect(current.providers.backlog.transition).toHaveBeenCalledWith('60', 'blocked', expect.anything());
    } finally {
      await plugins.dispose();
    }
  });

  it('runs a single inline plugin agent and publishes after QA passes', async () => {
    const current = fixture();
    const prompt = `Specialized ${templateName} agent`;
    if (templateName === 'merge-conflict-resolution') {
      current.providers.branches.mergeFeatureIntoBaseline.mockResolvedValue({ merged: false, conflicts: ['shared.txt'] });
    }
    const plugins = new PluginRuntime();
    await plugins.activate({
      id: 'specialized-template', version: '1.0.0',
      setup(context) { context.registerWorkflowTemplate({ name: templateName, version: 1, steps: [{ ...reviewer, prompt }] }); },
    });
    try {
      const runner = new QARunner(current.providers, config, {
        plugins, sandboxProvider: current.sandboxProvider, agentProvider: current.agentProvider, executionMode: 'batch',
      });

      expect(await runner.process('60')).toMatchObject({ success: true });
      expect(current.agentProvider.createExecution).toHaveBeenCalledWith(expect.objectContaining({ prompt: expect.stringContaining(prompt) }));
      expect(current.agentProvider.createExecution).toHaveBeenCalledTimes(templateName === 'merge-conflict-resolution' ? 2 : 1);
      expect(current.branches.push).toHaveBeenCalledOnce();
      expect(current.changes.create).toHaveBeenCalledOnce();
    } finally {
      await plugins.dispose();
    }
  });
});

describe('QARunner plugin publication policies', () => {
  it.each([0, 1, 2, 3])('enforces saved command verification through managed QA publication (failure invocation=%s)', async failureInvocation => {
    const root = await mkdtemp(join(tmpdir(), 'qa-saved-verification-'));
    const current = fixture();
    const completion = join(root, 'agent-completed');
    const receipt = join(root, 'verification.jsonl');
    const completed = current.execution.waitForResult.getMockImplementation()!;
    current.execution.waitForResult.mockImplementationOnce(async () => {
      await writeFile(completion, 'actual QA completion');
      return completed();
    });
    const command = [process.execPath, '-e', `const fs = require('node:fs');
      if (fs.readFileSync(${JSON.stringify(completion)}, 'utf8') !== 'actual QA completion') process.exit(11);
      fs.appendFileSync(${JSON.stringify(receipt)}, JSON.stringify({cwd:process.cwd()}) + '\\n');
      const invocation = fs.readFileSync(${JSON.stringify(receipt)}, 'utf8').trim().split('\\n').length;
      if (invocation === ${failureInvocation}) process.exit(7);`];
    await mkdir(join(root, '.afk'));
    await writeFile(join(root, '.afk', 'plugins.yml'), JSON.stringify({ plugins: [],
      integrations: { verifications: [{ provider: 'test-runner', command, timeoutMs: 5000 }] } }));
    const plugins = await createDefaultPluginRuntime({ homeDir: root, workspaceRoot: root });
    try {
      const runner = new QARunner(current.providers, config, {
        plugins, sandboxProvider: current.sandboxProvider, agentProvider: current.agentProvider,
      });
      const result = await runner.process('60');
      expect(result).toMatchObject({ success: failureInvocation === 0 });
      if (failureInvocation) expect(result.summary).toContain('Capability verification failed');
      const receipts = (await readFile(receipt, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      expect(receipts).toEqual(Array.from({ length: failureInvocation || 3 }, () => ({ cwd: expect.any(String) })));
      for (const observed of receipts) expect(observed.cwd).toBe(await realpath(worktreePath));
      expect(current.branches.commit).toHaveBeenCalledTimes(failureInvocation === 1 ? 0 : 1);
      expect(current.branches.push).toHaveBeenCalledTimes(failureInvocation === 0 || failureInvocation === 3 ? 1 : 0);
      expect(current.changes.create).toHaveBeenCalledTimes(failureInvocation === 0 ? 1 : 0);
      expect(current.changes.merge).not.toHaveBeenCalled();
      expect(current.branches.cleanup).toHaveBeenCalledWith(worktreePath, { preserve: failureInvocation !== 0 });
      expect(current.sandbox.close).toHaveBeenCalledOnce();
    } finally {
      await plugins.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('gathers plugin context before the QA prompt and completes lifecycle before publication', async () => {
    const current = fixture();
    const contextFile = join(worktreePath, '.afk', 'plugin-context.md');
    const onBeforeAgent = vi.fn(async () => { await mkdir(join(worktreePath, '.afk'), { recursive: true }); await writeFile(contextFile, 'Project knowledge'); });
    const onAfterAgent = vi.fn(async () => {});
    const onCleanup = vi.fn(async () => { await rm(contextFile, { force: true }); });
    const plugins = await policyRuntime({ name: 'qa-context', failureMode: 'required', onBeforeAgent, onAfterAgent, onCleanup });
    try {
      const runner = new QARunner(current.providers, config, { plugins, sandboxProvider: current.sandboxProvider, agentProvider: current.agentProvider });
      expect(await runner.process('60')).toMatchObject({ success: true });
      expect(current.agentProvider.createExecution).toHaveBeenCalledWith(expect.objectContaining({ prompt: expect.stringContaining('.afk/plugin-context.md') }));
      expect(onBeforeAgent.mock.invocationCallOrder[0]).toBeLessThan(current.agentProvider.createExecution.mock.invocationCallOrder[0]);
      expect(onAfterAgent.mock.invocationCallOrder[0]).toBeLessThan(current.branches.push.mock.invocationCallOrder[0]);
      expect(onCleanup).toHaveBeenCalledOnce();
    } finally { await plugins.dispose(); await rm(contextFile, { force: true }); }
  });
  async function policyRuntime(module: LifecycleModule) {
    const plugins = new PluginRuntime();
    await plugins.activate({
      id: 'qa-publication-policy', version: '1.0.0',
      setup(context) { context.registerLifecycle(module); },
    });
    return plugins;
  }

  it('does not restore an agent excluded from the plugin runtime registry', async () => {
    const current = fixture();
    const plugins = new PluginRuntime();
    try {
      expect(() => new QARunner(current.providers, { ...config, agentDefault: 'claude-code' }, {
        plugins, sandboxProvider: current.sandboxProvider,
      })).toThrow('agent provider not registered: claude-code');
    } finally {
      await plugins.dispose();
    }
  });

  it('does not restore the local sandbox when it is excluded from the plugin runtime registry', async () => {
    const current = fixture();
    const plugins = new PluginRuntime();
    try {
      expect(() => new QARunner(current.providers, config, {
        plugins, agentProvider: current.agentProvider,
      })).toThrow(/local/);
    } finally {
      await plugins.dispose();
    }
  });

  it('initializes plugins and rejects malformed configuration before starting QA or publishing', async () => {
    const current = fixture();
    const onInit = vi.fn(async () => { throw new Error('invalid plugin policy configuration'); });
    const onBeforePublish = vi.fn(async () => {});
    const plugins = await policyRuntime({ name: 'invalid-settings', failureMode: 'required', onInit, onBeforePublish });
    try {
      const runner = new QARunner(current.providers, config, {
        plugins, sandboxProvider: current.sandboxProvider, agentProvider: current.agentProvider,
      });
      expect(await runner.process('60')).toMatchObject({ success: false, summary: expect.stringContaining('invalid plugin policy configuration') });
      expect(onInit).toHaveBeenCalledWith(expect.objectContaining({ iid: 60, baseBranch: 'main', repoRoot: process.cwd() }));
      expect(current.branches.createVerificationWorktree).not.toHaveBeenCalled();
      expect(current.agentProvider.createExecution).not.toHaveBeenCalled();
      expect(onBeforePublish).not.toHaveBeenCalled();
      expect(current.branches.push).not.toHaveBeenCalled();
      expect(current.changes.create).not.toHaveBeenCalled();
    } finally {
      await plugins.dispose();
    }
  });

  it('evaluates required policy against the actual QA worktree and blocks its branch push', async () => {
    const current = fixture();
    const onBeforePublish = vi.fn(async (_context: LifecycleContext) => { throw new Error('QA policy denied'); });
    const onCleanup = vi.fn(async () => {});
    const plugins = await policyRuntime({ name: 'deny-publication', failureMode: 'required', onBeforePublish, onCleanup });
    try {
      const runner = new QARunner(current.providers, config, {
        plugins, sandboxProvider: current.sandboxProvider, agentProvider: current.agentProvider,
      });
      expect(await runner.process('60')).toMatchObject({ success: false, summary: expect.stringContaining('QA policy denied') });
      expect(onBeforePublish).toHaveBeenCalledOnce();
      expect(onBeforePublish).toHaveBeenCalledWith(expect.objectContaining({
        iid: 60, worktreePath, baseBranch: 'main', sessionName: expect.stringMatching(/^qa-60-/),
        repoRoot: process.cwd(), params: {},
      }));
      expect(current.branches.push).not.toHaveBeenCalled();
      expect(current.changes.create).not.toHaveBeenCalled();
      expect(onCleanup).toHaveBeenCalledWith(onBeforePublish.mock.calls[0]![0]);
      expect(current.branches.cleanup).toHaveBeenCalledWith(worktreePath, { preserve: true });
    } finally {
      await plugins.dispose();
    }
  });

  it.each(['create', 'refresh'] as const)('rechecks policy before change request %s after an allowed branch push', async publication => {
    const current = fixture();
    const refresh = vi.fn(async () => ({ id: 'pr-60' }));
    Object.assign(current.changes, { refresh });
    if (publication === 'refresh') {
      current.changes.findForBacklog.mockResolvedValue({
        id: 'pr-60', state: 'open', sourceBranch: 'qa-60', targetBranch: 'main',
      } as never);
    }
    const onBeforePublish = vi.fn(async () => {})
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('publication evidence rejected'));
    const plugins = await policyRuntime({ name: 'check-evidence', failureMode: 'required', onBeforePublish });
    try {
      const runner = new QARunner(current.providers, config, {
        plugins, sandboxProvider: current.sandboxProvider, agentProvider: current.agentProvider,
      });
      expect(await runner.process('60')).toMatchObject({ success: false, summary: expect.stringContaining('publication evidence rejected') });
      expect(onBeforePublish).toHaveBeenCalledTimes(2);
      expect(current.branches.push).toHaveBeenCalledWith('qa-60', worktreePath);
      expect(current.changes.create).not.toHaveBeenCalled();
      expect(refresh).not.toHaveBeenCalled();
      expect(current.changes.merge).not.toHaveBeenCalled();
    } finally {
      await plugins.dispose();
    }
  });

  it.each([false, true])('keeps identity, publication audit and the human merge gate when plugin policy allows publication (canonical=%s)', async canonical => {
    const current = fixture();
    const backlogId = canonical ? 'github:acme/repo#60' : '60';
    current.providers.backlog.get.mockResolvedValue({ ...await current.providers.backlog.get(), id: backlogId, providerRef: backlogId });
    const onInit = vi.fn(async () => {});
    const onBeforePublish = vi.fn(async () => {});
    const onCleanup = vi.fn(async () => {});
    const beforeChange = vi.fn(async () => {});
    const onCommit = vi.fn(async () => {});
    const afterPublication = vi.fn(async () => {});
    const plugins = await policyRuntime({ name: 'allow-publication', failureMode: 'required', onInit, onBeforePublish, onCleanup });
    try {
      const runner = new QARunner(current.providers, config, {
        plugins, sandboxProvider: current.sandboxProvider, agentProvider: current.agentProvider,
        beforeChange, onCommit, afterPublication,
      });
      expect(await runner.process('60')).toMatchObject({ success: true, mrUrl: 'https://example.test/pr/60' });
      expect(onInit).toHaveBeenCalledOnce();
      expect(onBeforePublish).toHaveBeenCalledTimes(2);
      expect(onBeforePublish).toHaveBeenCalledWith(expect.objectContaining({ iid: 60, worktreePath }));
      expect(onInit.mock.invocationCallOrder[0]).toBeLessThan(current.agentProvider.createExecution.mock.invocationCallOrder[0]);
      expect(beforeChange).toHaveBeenCalledWith('publish', expect.objectContaining({ id: backlogId }));
      expect(onCommit).toHaveBeenCalledWith('commit-60', 'qa-60');
      expect(onCommit.mock.invocationCallOrder[0]).toBeLessThan(onBeforePublish.mock.invocationCallOrder[0]!);
      expect(onBeforePublish.mock.invocationCallOrder[0]).toBeLessThan(current.branches.push.mock.invocationCallOrder[0]);
      expect(onBeforePublish.mock.invocationCallOrder[1]).toBeLessThan(current.changes.create.mock.invocationCallOrder[0]);
      expect(afterPublication).toHaveBeenCalledWith(expect.objectContaining({ id: 'pr-60' }));
      expect(onCleanup).toHaveBeenCalledOnce();
      expect(current.providers.backlog.transition).toHaveBeenCalledWith('60', 'merge_ready', expect.anything());
      expect(current.providers.backlog.setExecutionMode).toHaveBeenCalledWith('60', 'hitl');
      expect(current.changes.merge).not.toHaveBeenCalled();
    } finally {
      await plugins.dispose();
    }
  });
});

function persistentReworkFixture(platform: 'github' | 'gitlab', maxQaReworkAttempts = 3) {
  const issue: TrackedIssue = { id: 60, platform, title: 'search mode', description: 'support /s', labels: ['stage::qa', 'mode::afk'], state: 'opened', projectId: 'org/repo', url: '' };
  const comments: Array<{ id: string; body: string }> = [];
  const tracker = {
    platform, projectId: 'org/repo',
    getIssue: vi.fn(async () => ({ ...issue, labels: [...issue.labels] })),
    listIssues: vi.fn(async () => [issue]),
    listMRs: vi.fn(async () => []),
    updateLabels: vi.fn(async (_id, delta) => {
      issue.labels = [...issue.labels.filter(label => !delta.remove.includes(label)), ...delta.add];
    }),
    listIssueComments: vi.fn(async () => comments.map(comment => ({ ...comment }))),
    addComment: vi.fn(async (_id, body) => { comments.push({ id: `comment-${comments.length + 1}`, body }); }),
    updateIssueComment: vi.fn(async (_id, commentId, body) => {
      comments.find(comment => comment.id === commentId)!.body = body;
    }),
  } satisfies Partial<TrackerProvider>;
  const createRunner = () => {
    const f = fixture();
    const backlog = new TrackerBacklogProvider(tracker as TrackerProvider, { atomicClaim: vi.fn() });
    const transition = vi.spyOn(backlog, 'transition');
    const setExecutionMode = vi.spyOn(backlog, 'setExecutionMode');
    const createRework = vi.spyOn(backlog, 'createRework');
    f.execution.waitForResult.mockResolvedValue({
      version: 1, runId: 'execution-60', status: 'completed', provider: 'batch', commits: [],
      structuredOutput: {
        type: 'goal_complete', kind: 'qa', result: 'FAIL', summary: 'search shortcut failed',
        failedCriteria: [{ id: 'search-shortcut', expected: '/s enters search', actual: '/ does not enter search' }],
      },
    });
    const runner = new QARunner({ ...f.providers, backlog }, { ...config, maxQaReworkAttempts }, {
      sandboxProvider: f.sandboxProvider, agentProvider: f.agentProvider,
      executionMode: 'batch', mergeFeatureIntoBaseline: vi.fn(async () => ({ merged: true, conflicts: [] })),
      runtimeManager: {
        start: vi.fn(), heartbeat: vi.fn(), finish: vi.fn(), writeDiagnostics: vi.fn(), appendActivity: vi.fn(),
      } as any,
    });
    return { runner, backlog, transition, setExecutionMode, createRework };
  };
  return { comments, createRunner, resumeVerification: () => { issue.labels = ['stage::qa', 'mode::afk']; } };
}

describe('QARunner runtime binding', () => {
  it('resolves and probes the reviewer from an isolated plugin registry', async () => {
    const plugins = new PluginRuntime();
    const provider = { name: 'codex', capabilities: new Set(), createExecution: vi.fn() };
    await plugins.activate({
      manifest: { id: 'agent.codex', version: '1.0.0', apiVersion: 1, trusted: true, provides: ['agent.provider'] },
      activate(context) { context.registerAgentProvider('codex', provider); },
    });
    const prepareRuntime = vi.fn(async (runtime: unknown) => runtime);
    try {
      const runner = new QARunner(fixture().providers, {
        ...config, agentDefault: 'codex', agents: { codex: codexConfig },
      } as any, { plugins, sandboxProvider: fixture().sandboxProvider, prepareRuntime });
      expect((runner as any).agentProvider).toBe(provider);
      await (runner as any).probeOwnRuntime();
      expect(prepareRuntime).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'codex', provider: 'afk-zyuncs', profile: 'afk', transport: 'exec',
      }));
    } finally { await plugins.dispose(); }
  });

  const codexConfig = {
    transport: 'exec' as const,
    auth: 'auto' as const,
    provider: 'afk-zyuncs',
    profile: 'afk',
    appServer: { startupTimeoutMs: 30_000 },
  };

  /** Register a Codex provider AFK can resolve by name. */
  function withCodexProvider<T>(body: (provider: { name: 'codex' }) => T): T {
    const original = createAgentProvider('codex');
    const codex = { name: 'codex' as const, capabilities: new Set(), createExecution: vi.fn() };
    registerAgentProvider(codex);
    try {
      return body(codex);
    } finally {
      registerAgentProvider(original);
    }
  }

  it('gives a Codex reviewer the runtime that belongs to it', () => {
    // A reviewer that resolves its own provider from AFK's configuration
    // used to run with no runtime at all: no profile, no provider, no
    // transport. Codex then fell back to the host's own configuration and
    // talked to an endpoint nobody chose.
    withCodexProvider(() => {
      const runner = new QARunner(fixture().providers, {
        ...config, agentDefault: 'codex', agents: { codex: codexConfig },
      } as any);

      expect((runner as any).agentRuntime).toMatchObject({
        kind: 'codex', provider: 'afk-zyuncs', profile: 'afk', transport: 'exec',
      });
    });
  });

  it('probes a runtime the reviewer resolved itself before the agent starts', async () => {
    await withCodexProvider(async () => {
      const prepareRuntime = vi.fn(async (runtime: unknown) => runtime);
      const runner = new QARunner(fixture().providers, {
        ...config, agentDefault: 'codex', agents: { codex: codexConfig },
      } as any, { prepareRuntime });

      await (runner as any).probeOwnRuntime();

      expect(prepareRuntime).toHaveBeenCalledTimes(1);
    });
  });

  it('does not probe a runtime the caller already probed', async () => {
    await withCodexProvider(async () => {
      const prepareRuntime = vi.fn(async (runtime: unknown) => runtime);
      const injected = { kind: 'codex', transport: 'exec', auth: 'unknown', provider: 'afk-zyuncs', profile: 'afk', startupTimeoutMs: 30_000 };
      const runner = new QARunner(fixture().providers, {
        ...config, agentDefault: 'codex', agents: { codex: codexConfig },
      } as any, { agentRuntime: injected as any, prepareRuntime });

      await (runner as any).probeOwnRuntime();

      expect(prepareRuntime).not.toHaveBeenCalled();
      expect((runner as any).agentRuntime).toBe(injected);
    });
  });

  it('runs a Codex reviewer with the Codex runtime the caller handed over', async () => {
    await withCodexProvider(async codex => {
      const injected = { kind: 'codex', transport: 'exec', auth: 'unknown', provider: 'afk-zyuncs', profile: 'afk', startupTimeoutMs: 30_000 };
      const runner = new QARunner(fixture().providers, {
        ...config, agentDefault: 'codex', agents: { codex: codexConfig },
      } as any, { agentProvider: codex as any, agentRuntime: injected as any });

      expect((runner as any).agentRuntime).toBe(injected);
    });
  });
});

describe('QARunner execution boundary', () => {
  it.each(['explicit', 'saved'] as const)('shares %s trusted context with knowledge, experience and independent QA audit', async source => {
    const current = fixture();
    const queries: ContextQuery[] = [];
    const plugins = new PluginRuntime();
    await plugins.activate({ manifest: { id: 'qa.context', version: '1.0.0', apiVersion: 1, trusted: true, provides: ['context.provider'] },
      activate(context) {
        for (const id of ['context.experience', 'context.knowledge']) context.registerContextProvider(id, {
          id, capabilities: { 'read-only': true, summarize: false, search: true },
          async gather(query) { queries.push(query); return [{ origin: `${id}:qa-evidence`, content: 'bounded context' }]; },
        });
      } });
    const experienceContext = { applicability: { version: 'asset-2', environment: 'sandbox-ci' },
      target: { project: 'github:acme/wiki', productVersions: { sqlite: '3.45' } } };
    if (source === 'saved') await plugins.activate(createLearningPlugin({ config: { executionContexts: [experienceContext] } }));
    const onExperienceTarget = vi.fn(async (_context: unknown) => {});
    try {
      const runner = new QARunner(current.providers, config, { plugins, experienceContext: source === 'explicit' ? experienceContext : undefined, onExperienceTarget,
        sandboxProvider: current.sandboxProvider, agentProvider: current.agentProvider });
      await withLogContext({ runId: 'qa-context', workItemId: 'github:acme/wiki#60' }, () => runner.process('60'));
      expect(queries).toHaveLength(2);
      expect(queries[0]).toBe(queries[1]);
      expect(queries[0]).toMatchObject({ scope: 'github:acme/wiki', ...experienceContext });
      expect(onExperienceTarget).toHaveBeenCalledWith(expect.objectContaining(experienceContext));
      const content = await readFile(join(worktreePath, '.afk/experience-context.md'), 'utf8');
      expect(content).toContain('context.knowledge:qa-evidence');
      expect(content).toContain('context.experience:qa-evidence');
    } finally { await plugins.dispose(); }
  });

  it.each(['workItemId', 'canonical-id'] as const)('prefers the backlog %s over a foreign QA logger identity', async identitySource => {
    const current = fixture();
    const item = await current.providers.backlog.get('60');
    current.providers.backlog.get.mockResolvedValue({ ...item,
      ...(identitySource === 'workItemId' ? { workItemId: 'github:acme/wiki#60' } : { id: 'github:acme/wiki#60' }) });
    const onExperienceTarget = vi.fn(async (_context: unknown) => {});
    const runner = new QARunner(current.providers, config, { onExperienceTarget,
      sandboxProvider: current.sandboxProvider, agentProvider: current.agentProvider });
    const result = await withLogContext({ runId: 'foreign-qa-context', workItemId: 'github:foreign/private#88' }, () => runner.process('60'));
    expect(result.success).toBe(true);
    expect(onExperienceTarget).toHaveBeenCalledWith(expect.objectContaining({ target: expect.objectContaining({ project: 'github:acme/wiki' }) }));
  });

  it('resolves the configured agent provider when none is injected', () => {
    const original = createAgentProvider('codex');
    const codex = {
      name: 'codex' as const,
      capabilities: new Set(),
      createExecution: vi.fn(),
    };
    registerAgentProvider(codex);

    try {
      const runner = new QARunner(fixture().providers, { ...config, agentDefault: 'codex' });
      expect((runner as any).agentProvider).toBe(codex);
    } finally {
      registerAgentProvider(original);
    }
  });

  it('never starts the agent when the machine cannot run the acceptance criteria', async () => {
    const f = fixture();
    f.providers.backlog.get.mockResolvedValue({
      ...(await f.providers.backlog.get()),
      description: [
        '## Acceptance Criteria',
        '',
        '- [ ] 收件箱在某些条件下不能为空 -- test -- afk-tool-that-does-not-exist run',
        '',
      ].join('\n'),
    } as never);
    const runner = new QARunner(f.providers, config, {
      sandboxProvider: f.sandboxProvider,
      agentProvider: f.agentProvider,
      executionMode: 'batch',
      mergeFeatureIntoBaseline: vi.fn(async () => ({ merged: true, conflicts: [] })),
      runtimeManager: {
        start: vi.fn(), heartbeat: vi.fn(), finish: vi.fn(), writeDiagnostics: vi.fn(), appendActivity: vi.fn(),
      } as any,
    });

    const outcome = await runner.process('60');

    expect(outcome.success).toBe(false);
    expect(outcome.failureCode).toBe('qa_environment_missing');
    expect(outcome.summary).toContain('afk-tool-that-does-not-exist');
    expect(f.sandbox.startAgent).not.toHaveBeenCalled();
    expect(f.providers.backlog.transition).toHaveBeenCalledWith(
      '60', 'blocked', { reason: expect.stringContaining('afk-tool-that-does-not-exist') },
    );
  });

  it('runs batch QA through SandboxProvider without tmux readiness calls', async () => {
    const f = fixture();
    f.changes.findForBacklog.mockResolvedValue(null);
    const tmux = { createSession: vi.fn(), waitForPrompt: vi.fn(), sendPrompt: vi.fn(), waitForSignal: vi.fn() };
    const runtime = {
      kind: 'codex',
      transport: 'exec',
      auth: 'chatgpt',
      provider: 'openai',
      startupTimeoutMs: 5_000,
    } as const;
    const runner = new QARunner(f.providers, config, {
      sandboxProvider: f.sandboxProvider,
      agentProvider: f.agentProvider,
      agentRuntime: runtime,
      executionMode: 'batch',
      tmux: tmux as any,
      mergeFeatureIntoBaseline: vi.fn(async () => ({ merged: true, conflicts: [] })),
    });

    await expect(runner.process('60')).resolves.toMatchObject({ success: true });
    expect(f.execution.waitForResult).toHaveBeenCalledWith({ completionTimeoutMs: 2000 });
    expect(f.sandboxProvider.create).toHaveBeenCalledWith(expect.objectContaining({ executionMode: 'batch' }));
    expect(f.sandboxProvider.create.mock.calls[0][0].tmux).toBeUndefined();
    const session = f.sandboxProvider.create.mock.calls[0][0].session;
    expect(f.agentProvider.createExecution).toHaveBeenCalledWith({
      sandbox: f.sandbox,
      worktreePath: worktreePath,
      sessionId: session,
      executionMode: 'batch',
      signalType: 'goal_complete',
      prompt: expect.stringContaining('"kind":"qa"'),
      generation: 1,
      // The reviewer runs Claude Code, and a non-Codex provider never
      // inherits a Codex runtime: the provider and its runtime are one
      // decision (ADR-0032).
      runtime: undefined,
    });
    expect(f.sandbox.startAgent).not.toHaveBeenCalled();
    const qaPrompt = f.agentProvider.createExecution.mock.calls[0][0].prompt;
    expect(qaPrompt).toContain('不要把 commit、push 或创建 MR 作为本次 Agent 的失败条件');
    expect(qaPrompt).toContain('Backlog title: search mode');
    // The description is in the worktree, not in the goal: the goal
    // condition has a character budget the provider enforces.
    expect(qaPrompt).toContain('.afk/backlog-context.md');
    expect(qaPrompt).not.toContain('support /s');
    const context = await readFile(join(worktreePath, '.afk', 'backlog-context.md'), 'utf-8');
    expect(context).toContain('support /s');
    expect(context).toContain('search mode');
    expect(tmux.createSession).not.toHaveBeenCalled();
    expect(tmux.waitForPrompt).not.toHaveBeenCalled();
    expect(tmux.sendPrompt).not.toHaveBeenCalled();
    expect(tmux.waitForSignal).not.toHaveBeenCalled();
  });

  it('publishes the change request onto the baseline the execution declared', async () => {
    const f = fixture();
    const runner = new QARunner(f.providers, config, {
      sandboxProvider: f.sandboxProvider,
      agentProvider: f.agentProvider,
      executionMode: 'batch',
      mergeFeatureIntoBaseline: vi.fn(async () => ({ merged: true, conflicts: [] })),
      executionBaseBranch: '2025-11-8-show',
    });

    await expect(runner.process('60')).resolves.toMatchObject({ success: true });
    expect(f.changes.create).toHaveBeenCalledWith(expect.objectContaining({ targetBranch: '2025-11-8-show' }));
  });

  /**
   * The defect this guards: a description carrying the full acceptance
   * criteria list grew the goal condition until Claude Code's TUI refused
   * it. The refusal was silent, so the run died on an idle timeout half an
   * hour later with no cause anywhere.
   */
  it('keeps a long acceptance criteria list out of the goal condition', async () => {
    const f = fixture();
    const criteria = Array.from({ length: 120 }, (_, index) =>
      `- [ ] criterion ${index}: the entry hugs the bottom edge -- pnpm exec playwright test boot-${index}`,
    ).join('\n');
    expect(criteria.length).toBeGreaterThan(6000);
    f.providers.backlog.get.mockResolvedValue({
      ...(await f.providers.backlog.get()),
      description: criteria,
    } as never);
    const runner = new QARunner(f.providers, config, {
      sandboxProvider: f.sandboxProvider,
      agentProvider: f.agentProvider,
      executionMode: 'interactive',
      tmux: {} as any,
      mergeFeatureIntoBaseline: vi.fn(async () => ({ merged: true, conflicts: [] })),
    });

    const outcome = await runner.process('60');

    expect(outcome.success).toBe(true);
    const qaPrompt = f.agentProvider.createExecution.mock.calls[0][0].prompt as string;
    // The goal condition is what the TUI measures, and it fits.
    const goalCondition = qaPrompt.replace(/^\/goal\s*/i, '');
    expect(goalCondition.length).toBeLessThan(4000);
    expect(qaPrompt).not.toContain('criterion 119');
    // The criteria are in the worktree, where the agent can read them.
    const context = await readFile(join(worktreePath, '.afk', 'backlog-context.md'), 'utf-8');
    expect(context).toContain('criterion 119');
    expect(context.length).toBeGreaterThan(6000);
  });

  it('refuses a goal the provider would reject, before the agent is started', async () => {
    const f = fixture();
    f.agentProvider.promptLimits = { goalConditionMaxChars: 500 };
    const runner = new QARunner(f.providers, config, {
      sandboxProvider: f.sandboxProvider,
      agentProvider: f.agentProvider,
      executionMode: 'interactive',
      tmux: {} as any,
      mergeFeatureIntoBaseline: vi.fn(async () => ({ merged: true, conflicts: [] })),
    });

    const outcome = await runner.process('60');

    expect(outcome.success).toBe(false);
    expect(outcome.failureCode).toBe('prompt_budget_exceeded');
    expect(outcome.summary).toContain('500-character');
    expect(outcome.evidence?.some(entry => entry.label === 'goal condition length')).toBe(true);
    // The agent never saw the goal: no half hour of waiting for a refusal.
    expect(f.agentProvider.createExecution).not.toHaveBeenCalled();
    expect(f.sandbox.startAgent).not.toHaveBeenCalled();
    expect(f.providers.backlog.transition).toHaveBeenCalledWith(
      '60', 'blocked', { reason: expect.stringContaining('500-character') },
    );
  });

  it('classifies a QA execution timeout separately from a generic QA failure', async () => {
    const f = fixture();
    f.execution.waitForResult.mockResolvedValue({
      version: 1,
      runId: 'execution-60',
      status: 'timed_out',
      provider: 'batch',
      sessionId: 'agent-session-60',
      commits: [],
    });
    f.execution.captureOutput.mockResolvedValue('pane snapshot');
    const logRoot = await mkdtemp(join(tmpdir(), 'afk-qa-logs-'));
    const previousLogDir = process.env.AFK_LOG_DIR;
    process.env.AFK_LOG_DIR = logRoot;
    try {
      const runner = new QARunner(f.providers, { ...config, qaTimeout: 25 }, {
        sandboxProvider: f.sandboxProvider,
        agentProvider: f.agentProvider,
        executionMode: 'batch',
        mergeFeatureIntoBaseline: vi.fn(async () => ({ merged: true, conflicts: [] })),
      });

      await expect(runner.process('60')).resolves.toMatchObject({
        success: false,
        failureCode: 'agent_completion_timeout',
      });
      expect(f.execution.waitForResult).toHaveBeenCalledWith({ completionTimeoutMs: 25 });
      // The snapshot belongs under the AFK log root — not a second root.
      const snapshots = await readdir(join(logRoot, 'qa'));
      expect(snapshots).toEqual([expect.stringMatching(/^timeout-60-\d+\.log$/)]);
    } finally {
      if (previousLogDir === undefined) delete process.env.AFK_LOG_DIR;
      else process.env.AFK_LOG_DIR = previousLogDir;
      await rm(logRoot, { recursive: true, force: true });
    }
  });

  it('passes tmux only to the sandbox for interactive QA', async () => {
    const f = fixture();
    f.changes.findForBacklog.mockResolvedValue(null);
    const tmux = {};
    const runner = new QARunner(f.providers, config, {
      sandboxProvider: f.sandboxProvider,
      agentProvider: f.agentProvider,
      executionMode: 'interactive',
      tmux: tmux as any,
      mergeFeatureIntoBaseline: vi.fn(async () => ({ merged: true, conflicts: [] })),
    });

    await expect(runner.process('60')).resolves.toMatchObject({ success: true });
    expect(f.sandboxProvider.create.mock.calls[0][0]).toMatchObject({ executionMode: 'interactive', tmux });
  });

  it('configures the interactive statusline after merging the QA worktree', async () => {
    const f = fixture();
    const mergeFeatureIntoBaseline = vi.fn(async () => ({ merged: true, conflicts: [] }));
    ioMocks.configureStatusline.mockClear();
    const runner = new QARunner(f.providers, config, {
      sandboxProvider: f.sandboxProvider, agentProvider: f.agentProvider, executionMode: 'interactive',
      tmux: {} as any, mergeFeatureIntoBaseline,
    });

    await expect(runner.process('60')).resolves.toMatchObject({ success: true });

    expect(mergeFeatureIntoBaseline).toHaveBeenCalled();
    expect(ioMocks.configureStatusline).toHaveBeenCalledWith(worktreePath);
    expect(mergeFeatureIntoBaseline.mock.invocationCallOrder[0]).toBeLessThan(ioMocks.configureStatusline.mock.invocationCallOrder[0]);
  });

  it('publishes an independent QA runtime record through completion', async () => {
    const f = fixture();
    f.agentProvider.name = 'codex';
    f.execution.metadata = {
      provider: 'codex', transport: 'app-server', auth: 'chatgpt', modelProvider: 'openai',
      endpointKind: 'stdio', threadId: 'thread-60',
    };
    f.changes.findForBacklog.mockResolvedValue(null);
    const runtime = {
      start: vi.fn(async () => {}),
      heartbeat: vi.fn(async () => ({})),
      finish: vi.fn(async () => ({})),
      writeDiagnostics: vi.fn(async () => '/tmp/diagnostics'),
      appendActivity: vi.fn(async () => ({})),
    };
    const runner = new QARunner(f.providers, config, {
      sandboxProvider: f.sandboxProvider,
      agentProvider: f.agentProvider,
      executionMode: 'batch',
      mergeFeatureIntoBaseline: vi.fn(async () => ({ merged: true, conflicts: [] })),
      runtimeManager: runtime as any,
      agentRuntime: {
        kind: 'codex', transport: 'app-server', auth: 'chatgpt', provider: 'openai',
        endpoint: 'stdio://', startupTimeoutMs: 5_000,
      },
    });

    await expect(runner.process('60')).resolves.toMatchObject({ success: true });
    expect(runtime.start).toHaveBeenCalledWith(expect.objectContaining({
      backlogId: '60', workspace: process.cwd(), providerRef: '60',
      phase: 'verifying', executionMode: 'batch', status: 'running',
      agentProvider: 'codex', agentTransport: 'app-server', agentAuth: 'chatgpt', agentModelProvider: 'openai',
    }));
    expect(runtime.heartbeat).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      agentTransport: 'app-server', agentThreadId: 'thread-60',
    }));
    expect(runtime.heartbeat).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ worktree: worktreePath }));
    expect(runtime.writeDiagnostics).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      result: expect.objectContaining({ status: 'completed' }), output: expect.any(String),
    }));
    expect(runtime.appendActivity).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ kind: 'qa' }));
    expect(runtime.finish).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ status: 'completed' }));
  });

  it('persists a diagnosable QA failure as an AFK rework record', async () => {
    const f = fixture();
    f.execution.waitForResult.mockResolvedValue({
      version: 1,
      runId: 'execution-60',
      status: 'completed',
      provider: 'batch',
      structuredOutput: {
        type: 'goal_complete', kind: 'qa', result: 'FAIL', summary: 'search shortcut failed',
        failedCriteria: [{ id: 'search-shortcut', expected: '/s enters search', actual: '/ does not enter search' }],
      },
      commits: [],
    });
    const runtime = { start: vi.fn(async () => {}), heartbeat: vi.fn(async () => ({})), finish: vi.fn(async () => ({})), writeDiagnostics: vi.fn(async () => '/tmp/diagnostics') };
    const runner = new QARunner(f.providers, config, {
      sandboxProvider: f.sandboxProvider,
      agentProvider: f.agentProvider,
      executionMode: 'batch',
      mergeFeatureIntoBaseline: vi.fn(async () => ({ merged: true, conflicts: [] })),
      runtimeManager: runtime as any,
    });

    await expect(runner.process('60')).resolves.toMatchObject({
      success: false, rework: true, summary: 'search shortcut failed',
      failedCriteria: [{ id: 'search-shortcut', expected: '/s enters search', actual: '/ does not enter search' }],
    });
    expect(f.providers.backlog.createRework).toHaveBeenCalledWith('60', expect.objectContaining({
      source: 'qa', summary: 'search shortcut failed',
      failedCriteria: [{ id: 'search-shortcut', expected: '/s enters search', actual: '/ does not enter search' }],
    }));
    expect(f.providers.backlog.transition).not.toHaveBeenCalledWith('60', 'blocked', expect.anything());
    expect(runtime.finish).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      status: 'blocked', errorSummary: expect.stringContaining('search shortcut failed'),
    }));
  });

  it.each(['github', 'gitlab'] as const)('bounds repeated active QA FAIL using persisted %s comments across runners', async platform => {
    const f = persistentReworkFixture(platform);
    for (let attempt = 1; attempt <= 3; attempt++) {
      f.resumeVerification();
      const current = f.createRunner();
      const result = await current.runner.process('60');
      expect(result.success).toBe(false);
      expect(result.summary).toContain('search shortcut failed');
      expect(result.failedCriteria).toEqual([{ id: 'search-shortcut', expected: '/s enters search', actual: '/ does not enter search' }]);
      await expect(current.backlog.getActiveRework('60')).resolves.toMatchObject({ id: `r1-${attempt}`, cycle: 1, attempt, status: 'open' });
      expect(f.comments.map(comment => parseReworkRecord(comment)?.record.status)).toEqual([
        ...Array(attempt - 1).fill('superseded'), 'open',
      ]);
      if (attempt < 3) {
        expect(result.rework).toBe(true);
        await expect(current.backlog.get('60')).resolves.toMatchObject({ state: 'rework', executionMode: 'afk' });
      } else {
        expect(result.rework).not.toBe(true);
        expect(result.summary).toContain('3/3');
        await expect(current.backlog.get('60')).resolves.toMatchObject({ state: 'blocked', executionMode: 'hitl' });
        expect(await current.backlog.isRunnable(await current.backlog.get('60'))).toBe(false);
        expect(current.transition).not.toHaveBeenCalledWith('60', 'rework', expect.anything());
        expect(current.transition).not.toHaveBeenCalledWith('60', 'rework');
        expect(current.setExecutionMode).not.toHaveBeenCalledWith('60', 'afk');
      }
    }
    const subsequent = f.createRunner();
    const subsequentResult = await subsequent.runner.process('60');
    expect(subsequentResult).toMatchObject({ success: false });
    expect(subsequentResult.rework).not.toBe(true);
    await expect(subsequent.backlog.get('60')).resolves.toMatchObject({ state: 'blocked', executionMode: 'hitl' });
    expect(subsequent.createRework).not.toHaveBeenCalled();
    expect(subsequent.transition).not.toHaveBeenCalledWith('60', 'rework', expect.anything());
    expect(subsequent.transition).not.toHaveBeenCalledWith('60', 'rework');
    expect(subsequent.setExecutionMode).not.toHaveBeenCalledWith('60', 'afk');
    expect(f.comments).toHaveLength(3);
  });

  it('keeps reworking after an operator retry when the QA budget of the cycle was spent', async () => {
    const f = persistentReworkFixture('gitlab');
    // The item fails QA until the budget of the first cycle is spent.
    for (let attempt = 1; attempt <= 3; attempt++) {
      f.resumeVerification();
      const current = f.createRunner();
      const result = await current.runner.process('60');
      expect(result.rework === true).toBe(attempt < 3);
    }
    const exhausted = f.createRunner();
    await expect(exhausted.backlog.get('60')).resolves.toMatchObject({ state: 'blocked', executionMode: 'hitl' });
    await expect(exhausted.backlog.getActiveRework('60')).resolves.toMatchObject({ cycle: 1, attempt: 3 });

    // The operator fixed the defect and retries the item.
    await expect(retryBacklog(exhausted.backlog, '60', 'the missing assets are added')).resolves.toMatchObject({
      state: 'rework', executionMode: 'afk',
    });

    // The next QA failure is the first attempt of the new cycle, so it is a
    // rework again instead of an immediate block.
    f.resumeVerification();
    const afterRetry = f.createRunner();
    const result = await afterRetry.runner.process('60');
    expect(result.success).toBe(false);
    expect(result.rework).toBe(true);
    expect(result.summary).toContain('search shortcut failed');
    await expect(afterRetry.backlog.get('60')).resolves.toMatchObject({ state: 'rework', executionMode: 'afk' });
    await expect(afterRetry.backlog.getActiveRework('60')).resolves.toMatchObject({ cycle: 2, attempt: 1, status: 'open' });
  });

  it('names the cycle and the used attempts when the QA rework budget is spent', async () => {
    const f = persistentReworkFixture('github');
    for (let attempt = 1; attempt <= 3; attempt++) {
      f.resumeVerification();
      const current = f.createRunner();
      await current.runner.process('60');
    }
    const exhausted = f.createRunner();
    await expect(exhausted.backlog.get('60')).resolves.toMatchObject({ state: 'blocked', executionMode: 'hitl' });
    const record = await exhausted.backlog.getActiveRework('60');
    expect(record).toMatchObject({ cycle: 1, attempt: 3 });

    // A failure that arrives while the budget is spent says which round of
    // work it belongs to and how much of the budget that round used.
    f.resumeVerification();
    const blocked = f.createRunner();
    const result = await blocked.runner.process('60');
    expect(result.rework).not.toBe(true);
    expect(result.summary).toContain('cycle 1');
    expect(result.summary).toContain('3/3');
  });

  it.each([1, 4])('honors a configured QA failure limit of %s', async limit => {
    const f = persistentReworkFixture('github', limit);
    for (let attempt = 1; attempt <= limit; attempt++) {
      f.resumeVerification();
      const current = f.createRunner();
      const result = await current.runner.process('60');
      expect(result.rework === true).toBe(attempt < limit);
      await expect(current.backlog.getActiveRework('60')).resolves.toMatchObject({ attempt });
      await expect(current.backlog.get('60')).resolves.toMatchObject({
        state: attempt < limit ? 'rework' : 'blocked', executionMode: attempt < limit ? 'afk' : 'hitl',
      });
      if (attempt === limit) {
        expect(current.transition).not.toHaveBeenCalledWith('60', 'rework');
        expect(current.setExecutionMode).not.toHaveBeenCalledWith('60', 'afk');
      }
    }
  });

  it('returns a diagnostic summary when the QA agent fails to start', async () => {
    const f = fixture();
    f.agentProvider.createExecution.mockRejectedValueOnce(new Error('provider unavailable'));
    const runner = new QARunner(f.providers, config, {
      sandboxProvider: f.sandboxProvider,
      agentProvider: f.agentProvider,
      executionMode: 'batch',
      mergeFeatureIntoBaseline: vi.fn(async () => ({ merged: true, conflicts: [] })),
    });

    await expect(runner.process('60')).resolves.toMatchObject({
      success: false,
      summary: 'QA execution failed: provider unavailable',
    });
  });

  it('routes a failed backlog lookup to blocked with a diagnostic summary', async () => {
    const f = fixture();
    f.providers.backlog.get.mockRejectedValueOnce(new Error('provider read unavailable'));
    const runner = new QARunner(f.providers, config, { sandboxProvider: f.sandboxProvider, agentProvider: f.agentProvider });

    await expect(runner.process('60')).resolves.toMatchObject({ success: false, summary: 'QA execution failed: provider read unavailable' });
    expect(f.providers.backlog.transition).toHaveBeenCalledWith('60', 'blocked', { reason: 'QA execution failed: provider read unavailable' });
    expect(f.providers.backlog.setExecutionMode).toHaveBeenCalledWith('60', 'hitl');
  });

  it('resolves the active QA rework record only after QA passes', async () => {
    const f = fixture();
    f.providers.backlog.getActiveRework.mockResolvedValue({ id: 'r1-1', cycle: 1, attempt: 1, summary: 'search shortcut failed' });
    const runner = new QARunner(f.providers, config, {
      sandboxProvider: f.sandboxProvider, agentProvider: f.agentProvider, executionMode: 'batch', mergeFeatureIntoBaseline: vi.fn(async () => ({ merged: true, conflicts: [] })),
    });

    await expect(runner.process('60')).resolves.toMatchObject({ success: true });
    expect(f.providers.backlog.resolveRework).toHaveBeenCalledWith('60', 'r1-1', expect.objectContaining({ summary: expect.stringContaining('QA passed') }));
  });

  it('commits and creates a mergeable change after QA on the root backlog without merging', async () => {
    const f = fixture();
    const root = { ...(await f.providers.backlog.get('60')), parentId: undefined };
    f.providers.backlog.get.mockResolvedValue(root);
    const mergeFeatureIntoBaseline = vi.fn(async () => ({ merged: true, conflicts: [] }));
    const runner = new QARunner(f.providers, config, {
      sandboxProvider: f.sandboxProvider,
      agentProvider: f.agentProvider,
      executionMode: 'batch',
      mergeFeatureIntoBaseline,
    });

    const result = await runner.process('60');

    expect(result).toMatchObject({ success: true });
    expect(mergeFeatureIntoBaseline).toHaveBeenCalledWith(worktreePath, 'main', 'afk/backlog-60');
    expect(f.providers.branches.commit).toHaveBeenCalledWith(worktreePath, expect.stringContaining('QA'));
    expect(f.providers.branches.push).toHaveBeenCalledWith('qa-60', worktreePath);
    expect(f.providers.changes.create).toHaveBeenCalledWith(expect.objectContaining({
      sourceBranch: 'qa-60', targetBranch: 'main', draft: false,
    }));
    expect(f.providers.changes.merge).not.toHaveBeenCalled();
    expect(f.providers.backlog.transition).toHaveBeenCalledWith('60', 'merge_ready', expect.anything());
    expect(f.providers.backlog.setExecutionMode).toHaveBeenCalledWith('60', 'hitl');
  });

  it('passes the local QA commit SHA to the audit hook', async () => {
    const f = fixture();
    const onCommit = vi.fn(async () => {});
    const runner = new QARunner(f.providers, config, {
      sandboxProvider: f.sandboxProvider,
      agentProvider: f.agentProvider,
      executionMode: 'batch',
      mergeFeatureIntoBaseline: vi.fn(async () => ({ merged: true, conflicts: [] })),
      onCommit,
    });

    await runner.process('60');

    expect(onCommit).toHaveBeenCalledWith('commit-60', 'qa-60');
  });

  it('resolves a merge conflict in the QA worktree before verifying', async () => {
    const f = fixture();
    f.providers.branches.mergeFeatureIntoBaseline.mockResolvedValue({ merged: false, conflicts: ['shared.txt', 'notes.bin'] });
    f.providers.branches.listUnresolvedConflicts.mockResolvedValue([]);
    const prompts: string[] = [];
    f.agentProvider.createExecution = vi.fn(async (options: any) => {
      prompts.push(options.prompt);
      return f.execution;
    });
    const runner = new QARunner(f.providers, config, {
      sandboxProvider: f.sandboxProvider,
      agentProvider: f.agentProvider,
      executionMode: 'batch',
    });

    const result = await runner.process('60');

    expect(result).toMatchObject({ success: true });
    // The conflict is resolved in the worktree the change request is
    // published from, and the resolution is committed there.
    expect(f.providers.branches.commit).toHaveBeenCalledWith(worktreePath, 'Resolve merge conflict with main');
    expect(prompts[0]).toContain('shared.txt');
    expect(prompts[0]).toContain('notes.bin');
    expect(prompts[0]).toContain('main');
    // The verification runs after the conflict is gone.
    expect(prompts).toHaveLength(2);
    expect(f.providers.backlog.transition).toHaveBeenCalledWith('60', 'merge_ready', expect.anything());
  });

  it('reports a conflict nobody can resolve to a person', async () => {
    const f = fixture();
    f.providers.branches.mergeFeatureIntoBaseline.mockResolvedValue({ merged: false, conflicts: ['notes.bin'] });
    f.providers.branches.listUnresolvedConflicts.mockResolvedValue(['notes.bin']);
    const runner = new QARunner(f.providers, config, {
      sandboxProvider: f.sandboxProvider,
      agentProvider: f.agentProvider,
      executionMode: 'batch',
    });

    const result = await runner.process('60');

    expect(result).toMatchObject({ success: false, failureCode: 'merge_conflict' });
    expect(result.summary).toContain('notes.bin');
    expect(f.providers.backlog.transition).toHaveBeenCalledWith('60', 'blocked', expect.objectContaining({
      reason: expect.stringContaining('notes.bin'),
    }));
    expect(f.providers.backlog.setExecutionMode).toHaveBeenCalledWith('60', 'hitl');
    expect(f.providers.changes.create).not.toHaveBeenCalled();
  });

  it('sends a published change request that conflicts back for another round', async () => {
    const f = fixture();
    f.changes.get.mockResolvedValue({
      id: 'pr-60', state: 'open', sourceBranch: 'qa-60', targetBranch: 'main',
      mergeState: 'conflict', url: 'https://example.test/pr/60',
    });
    const runner = new QARunner(f.providers, config, {
      sandboxProvider: f.sandboxProvider,
      agentProvider: f.agentProvider,
      executionMode: 'batch',
      mergeFeatureIntoBaseline: vi.fn(async () => ({ merged: true, conflicts: [] })),
    });

    const result = await runner.process('60');

    expect(result).toMatchObject({ success: false, rework: true, failureCode: 'merge_conflict' });
    expect(f.providers.backlog.createRework).toHaveBeenCalledWith('60', expect.objectContaining({ source: 'conflict' }));
    expect(f.providers.backlog.transition).toHaveBeenCalledWith('60', 'rework', expect.objectContaining({
      reason: expect.stringContaining('conflicts with main'),
    }));
    expect(f.providers.backlog.setExecutionMode).toHaveBeenCalledWith('60', 'afk');
    // A change request that cannot land is never handed over as ready.
    expect(f.providers.backlog.transition).not.toHaveBeenCalledWith('60', 'merge_ready', expect.anything());
  });

  it('escalates a change request whose target branch already carries it instead of redoing the work', async () => {
    const f = fixture();
    f.changes.get.mockResolvedValue({
      id: 'pr-60', state: 'open', sourceBranch: 'qa-60', targetBranch: 'main',
      mergeState: 'baseline_advanced', url: 'https://example.test/pr/60',
    });
    const runner = new QARunner(f.providers, config, {
      sandboxProvider: f.sandboxProvider,
      agentProvider: f.agentProvider,
      executionMode: 'batch',
      mergeFeatureIntoBaseline: vi.fn(async () => ({ merged: true, conflicts: [] })),
    });

    const result = await runner.process('60');

    expect(result).toMatchObject({ success: false, failureCode: 'baseline_advanced' });
    // The loop this state was split out to break: a target branch that
    // already carries the change is never answered with another round of
    // work, because the next round would move the baseline again.
    expect(f.providers.backlog.createRework).not.toHaveBeenCalled();
    expect(f.providers.backlog.transition).not.toHaveBeenCalledWith('60', 'rework', expect.anything());
    expect(f.providers.backlog.transition).toHaveBeenCalledWith('60', 'blocked', expect.objectContaining({
      reason: expect.stringContaining('already carries its commits'),
    }));
    expect(f.providers.backlog.setExecutionMode).toHaveBeenCalledWith('60', 'hitl');
    expect(f.providers.backlog.transition).not.toHaveBeenCalledWith('60', 'merge_ready', expect.anything());
  });

  it('keeps a change request the platform has not judged yet out of the conflict path', async () => {    const f = fixture();
    f.changes.get.mockResolvedValue({
      id: 'pr-60', state: 'open', sourceBranch: 'qa-60', targetBranch: 'main',
      mergeState: 'unknown', url: 'https://example.test/pr/60',
    });
    const runner = new QARunner(f.providers, config, {
      sandboxProvider: f.sandboxProvider,
      agentProvider: f.agentProvider,
      executionMode: 'batch',
      mergeFeatureIntoBaseline: vi.fn(async () => ({ merged: true, conflicts: [] })),
    });

    const result = await runner.process('60');

    expect(result).toMatchObject({ success: true });
    expect(f.providers.backlog.createRework).not.toHaveBeenCalled();
    expect(f.providers.backlog.transition).toHaveBeenCalledWith('60', 'merge_ready', expect.anything());
  });

  it('hands a conflict that outlived the attempt limit to a person', async () => {
    const f = fixture();
    f.changes.get.mockResolvedValue({
      id: 'pr-60', state: 'open', sourceBranch: 'qa-60', targetBranch: 'main',
      mergeState: 'conflict', url: 'https://example.test/pr/60',
    });
    // The previous round is still open: a conflict means it did not do its
    // job, so the attempt count carries on.
    f.providers.backlog.getActiveRework.mockResolvedValue({ id: 'r1-3', cycle: 1, attempt: 3, status: 'open', source: 'conflict' });
    const runner = new QARunner(f.providers, config, {
      sandboxProvider: f.sandboxProvider,
      agentProvider: f.agentProvider,
      executionMode: 'batch',
      mergeFeatureIntoBaseline: vi.fn(async () => ({ merged: true, conflicts: [] })),
    });

    const result = await runner.process('60');

    expect(result).toMatchObject({ success: false, failureCode: 'merge_conflict' });
    expect(f.providers.backlog.createRework).not.toHaveBeenCalled();
    expect(f.providers.backlog.transition).toHaveBeenCalledWith('60', 'blocked', expect.objectContaining({
      reason: expect.stringContaining('conflicts with main'),
    }));
    expect(f.providers.backlog.setExecutionMode).toHaveBeenCalledWith('60', 'hitl');
  });

  it('publishes the per-criterion evidence and the artifact worktree with the change request', async () => {
    const f = fixture();
    f.execution.waitForResult.mockResolvedValue({
      version: 1, runId: 'execution-60', status: 'completed', provider: 'batch', commits: [],
      structuredOutput: {
        type: 'goal_complete', kind: 'qa', result: 'PASS', summary: 'every criterion was re-run',
        requiredChecks: [{ command: 'pnpm exec playwright test boot', expected: '5 passed' }],
        observations: [{ claim: 'the entry hugs the bottom edge', evidence: 'boot spec' }],
        notes: 'the worktree node_modules was materialized as a real directory',
      },
    });
    const root = await mkdtemp(join(tmpdir(), 'afk-qa-artifacts-'));
    await mkdir(join(root, '.afk'), { recursive: true });
    await writeFile(join(root, '.afk', 'artifacts.txt'), '/tmp/boot.png\n', 'utf-8');
    f.branches.createVerificationWorktree.mockResolvedValue({ branchName: 'qa-60', worktreePath: root });
    const runner = new QARunner(f.providers, config, {
      sandboxProvider: f.sandboxProvider,
      agentProvider: f.agentProvider,
      executionMode: 'batch',
      mergeFeatureIntoBaseline: vi.fn(async () => ({ merged: true, conflicts: [] })),
    });

    await runner.process('60');

    expect(f.providers.changes.create).toHaveBeenCalledWith(expect.objectContaining({
      worktreePath: root,
      commitSha: 'commit-60',
      evidence: {
        summary: 'every criterion was re-run',
        checks: [{ command: 'pnpm exec playwright test boot', expected: '5 passed' }],
        observations: [{ claim: 'the entry hugs the bottom edge', evidence: 'boot spec' }],
        notes: 'the worktree node_modules was materialized as a real directory',
      },
    }));
    await rm(root, { recursive: true, force: true });
  });

  it('keeps a PASS result when the reported observations are malformed', async () => {
    const f = fixture();
    f.execution.waitForResult.mockResolvedValue({
      version: 1, runId: 'execution-60', status: 'completed', provider: 'batch', commits: [],
      structuredOutput: {
        type: 'goal_complete', kind: 'qa', result: 'PASS', summary: 'every criterion was re-run',
        requiredChecks: [{ command: 'pnpm exec playwright test boot', expected: '5 passed' }],
        observations: [{ evidence: 'no claim here' }, 'not an object'],
      },
    });
    const runner = new QARunner(f.providers, config, {
      sandboxProvider: f.sandboxProvider,
      agentProvider: f.agentProvider,
      executionMode: 'batch',
      mergeFeatureIntoBaseline: vi.fn(async () => ({ merged: true, conflicts: [] })),
    });

    await expect(runner.process('60')).resolves.toMatchObject({ success: true });
    expect(f.providers.changes.create).toHaveBeenCalledWith(expect.objectContaining({
      evidence: expect.objectContaining({ observations: undefined }),
    }));
  });

  it('records that a QA run published no artifact manifest', async () => {
    const f = fixture();
    const root = await mkdtemp(join(tmpdir(), 'afk-qa-no-artifacts-'));
    f.branches.createVerificationWorktree.mockResolvedValue({ branchName: 'qa-60', worktreePath: root });
    const appendActivity = vi.fn(async () => ({}));
    const runner = new QARunner(f.providers, config, {
      sandboxProvider: f.sandboxProvider,
      agentProvider: f.agentProvider,
      executionMode: 'batch',
      mergeFeatureIntoBaseline: vi.fn(async () => ({ merged: true, conflicts: [] })),
      runtimeManager: {
        start: vi.fn(), heartbeat: vi.fn(), finish: vi.fn(), writeDiagnostics: vi.fn(), appendActivity,
      } as any,
    });

    await runner.process('60');

    expect(appendActivity).toHaveBeenCalledWith(
      expect.stringContaining('qa-60'),
      expect.objectContaining({ kind: 'qa', message: expect.stringContaining('no artifact manifest') }),
    );
    await rm(root, { recursive: true, force: true });
  });

  it('keeps the managed execution log context throughout QA', async () => {
    const f = fixture();
    const context = { runId: 'managed-attempt', workItemId: 'github:org/repo#60' };
    const onCommit = vi.fn(async () => { expect(getLogContext()).toEqual(context); });
    const runner = new QARunner(f.providers, config, {
      sandboxProvider: f.sandboxProvider, agentProvider: f.agentProvider, executionMode: 'batch',
      mergeFeatureIntoBaseline: vi.fn(async () => ({ merged: true, conflicts: [] })), onCommit,
    });
    await withLogContext(context, () => runner.process('60'));
    expect(onCommit).toHaveBeenCalledOnce();
    expect(f.sandboxProvider.create).toHaveBeenCalledWith(expect.objectContaining({ runtimeRunId: context.runId }));
    expect(getLogContext()).toBeUndefined();
  });

  it('does not call the audit hook when the branch provider reports no commit', async () => {
    const f = fixture();
    f.branches.commit.mockResolvedValue(undefined as never);
    const onCommit = vi.fn(async () => {});
    const runner = new QARunner(f.providers, config, {
      sandboxProvider: f.sandboxProvider,
      agentProvider: f.agentProvider,
      executionMode: 'batch',
      mergeFeatureIntoBaseline: vi.fn(async () => ({ merged: true, conflicts: [] })),
      onCommit,
    });

    await runner.process('60');

    expect(onCommit).not.toHaveBeenCalled();
  });

  it.each(['tokens', 'handoffs', 'corrupt'] as const)('blocks QA before starting an agent for a %s budget ledger', async condition => {
    const root = await mkdtemp(join(tmpdir(), 'afk-qa-budget-'));
    try {
      const store = new BudgetStore(root, '60');
      await store.save({ used: condition === 'handoffs' ? 1 : 0, tokens: 100, sessions: { session: 100 } });
      if (condition === 'corrupt') await writeFile(join(workspaceDataDirectory(root), 'budgets', '60.json'), '{}');
      const f = fixture();
      const runner = new QARunner(f.providers, { ...config, goalBudget: condition === 'tokens' ? 100 : 1000 }, {
        sandboxProvider: f.sandboxProvider, agentProvider: f.agentProvider, projectRoot: root,
        executionMode: 'batch', mergeFeatureIntoBaseline: vi.fn(async () => ({ merged: true, conflicts: [] })),
      });
      const result = await runner.process('60');
      expect(result).toMatchObject({ success: false, summary: expect.stringContaining(condition === 'corrupt' ? 'corrupt' : 'budget exhausted') });
      expect(f.agentProvider.createExecution).not.toHaveBeenCalled();
      expect(f.providers.branches.createVerificationWorktree).not.toHaveBeenCalled();
      expect(f.providers.backlog.setExecutionMode).toHaveBeenCalledWith('60', 'hitl');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each(['local', 'docker', 'podman'])('records QA native usage in %s without counting a repeated session twice', async sandboxName => {
    const root = await mkdtemp(join(tmpdir(), 'afk-qa-usage-'));
    const previousHome = process.env.HOME;
    try {
      const f = fixture();
      f.sandboxProvider.name = sandboxName;
      const nativeSessionId = 'f1817331-17b7-40e2-98f0-834f6b02320c';
      f.execution.telemetryPath = join(root, 'qa-204-1791984447541.jsonl');
      f.execution.metadata.threadId = nativeSessionId;
      await writeFile(join(root, `${nativeSessionId}.jsonl`), JSON.stringify({ session_id: nativeSessionId }) + '\n');
      process.env.HOME = root;
      const result = await f.execution.waitForResult();
      const tools = [{ id: 'qa-tool', name: 'Bash', result: 'failed', exitCode: 1 }];
      f.execution.waitForResult.mockResolvedValue({ ...result, sessionId: 'qa-204-1791984447541', usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 }, tools } as never);
      const onSession = vi.fn(async () => {});
      for (let attempt = 0; attempt < 2; attempt++) {
        const runner = new QARunner(f.providers, { ...config, goalBudget: 1000 }, {
          sandboxProvider: f.sandboxProvider, agentProvider: f.agentProvider, projectRoot: root,
          executionMode: 'batch', mergeFeatureIntoBaseline: vi.fn(async () => ({ merged: true, conflicts: [] })), onSession,
        });
        expect(await runner.process('60')).toMatchObject({ success: true });
      }
      expect(await new BudgetStore(root, '60').load()).toMatchObject({ used: 0, tokens: 15, sessions: { [nativeSessionId]: 15 } });
      expect(onSession).toHaveBeenCalledWith({
        kind: 'agent.session_recorded', sessionId: nativeSessionId,
        ...(sandboxName === 'local' ? { transcriptPath: join(root, `${nativeSessionId}.jsonl`) } : {}),
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 }, tools,
      });
    } finally {
      process.env.HOME = previousHome;
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not publish when the attempt audit refuses publication', async () => {
    const fixtureData = fixture();
    const beforeChange = vi.fn(async () => { throw new Error('audit unavailable'); });
    const runner = new QARunner(fixtureData.providers, config, {
      sandboxProvider: fixtureData.sandboxProvider, agentProvider: fixtureData.agentProvider,
      executionMode: 'batch', mergeFeatureIntoBaseline: vi.fn(async () => ({ merged: true, conflicts: [] })), beforeChange,
    });
    expect(await runner.process('60')).toMatchObject({ success: false });
    expect(beforeChange).toHaveBeenCalledWith('publish', expect.objectContaining({ id: '60' }));
    expect(fixtureData.changes.create).not.toHaveBeenCalled();
    expect(fixtureData.changes.merge).not.toHaveBeenCalled();
  });

  it('never merges a change on its own, not even a child backlog', async () => {
    const fixtureData = fixture();
    fixtureData.providers.backlog.get.mockResolvedValue({ ...await fixtureData.providers.backlog.get('60'), parentId: '11' });
    const runner = new QARunner(fixtureData.providers, config, {
      sandboxProvider: fixtureData.sandboxProvider, agentProvider: fixtureData.agentProvider,
      executionMode: 'batch', mergeFeatureIntoBaseline: vi.fn(async () => ({ merged: true, conflicts: [] })),
    });

    // The merge is a person's decision. AFK publishes the change request and
    // waits for it — it has no way to merge one on its own.
    expect(await runner.process('60')).toMatchObject({ success: true });
    expect(fixtureData.changes.merge).not.toHaveBeenCalled();
    expect(fixtureData.providers.backlog.transition).toHaveBeenCalledWith('60', 'merge_ready', expect.anything());
    expect(fixtureData.providers.backlog.transition).not.toHaveBeenCalledWith('60', 'done', expect.anything());
    expect(fixtureData.providers.backlog.setExecutionMode).toHaveBeenCalledWith('60', 'hitl');
  });

  it('reuses a matching open change instead of creating a duplicate for an audited attempt', async () => {
    const fixtureData = fixture();
    fixtureData.changes.findForBacklog.mockResolvedValue({
      id: 'pr-60', state: 'open', sourceBranch: 'qa-60', targetBranch: 'main', url: 'https://example.test/pr/60',
    });
    const afterPublication = vi.fn(async () => {});
    const runner = new QARunner(fixtureData.providers, config, {
      sandboxProvider: fixtureData.sandboxProvider, agentProvider: fixtureData.agentProvider,
      executionMode: 'batch', mergeFeatureIntoBaseline: vi.fn(async () => ({ merged: true, conflicts: [] })),
      beforeChange: vi.fn(async () => {}), afterPublication,
    });
    expect(await runner.process('60')).toMatchObject({ success: true, mrUrl: 'https://example.test/pr/60' });
    expect(fixtureData.changes.create).not.toHaveBeenCalled();
    expect(afterPublication).toHaveBeenCalledWith(expect.objectContaining({ id: 'pr-60' }));
  });

  it('publishes an organizational child backlog and waits for a human to merge it', async () => {
    const f = fixture();
    const child = { ...(await f.providers.backlog.get('60')), parentId: '10' };
    f.providers.backlog.get.mockResolvedValue(child);
    f.changes.findForBacklog.mockResolvedValue(null);
    const mergeFeatureIntoBaseline = vi.fn(async () => ({ merged: true, conflicts: [] }));
    const runner = new QARunner(f.providers, config, {
      sandboxProvider: f.sandboxProvider,
      agentProvider: f.agentProvider,
      executionMode: 'batch',
      mergeFeatureIntoBaseline,
    });

    const result = await runner.process('60');

    // Merging is a person's decision: the change is published into the
    // configured target branch and waits there.
    expect(result).toMatchObject({ success: true });
    expect(mergeFeatureIntoBaseline).toHaveBeenCalledWith(worktreePath, 'main', 'afk/backlog-60');
    expect(f.providers.changes.create).toHaveBeenCalledWith(expect.objectContaining({ targetBranch: 'main' }));
    expect(f.providers.changes.merge).not.toHaveBeenCalled();
    expect(f.providers.backlog.transition).toHaveBeenCalledWith('60', 'merge_ready', expect.anything());
    expect(f.providers.backlog.setExecutionMode).toHaveBeenCalledWith('60', 'hitl');
  });

  it('publishes an organizational child backlog and waits for a human to merge it', async () => {
    const f = fixture();
    const child = { ...(await f.providers.backlog.get('60')), parentId: '10' };
    f.providers.backlog.get.mockResolvedValue(child);
    f.changes.findForBacklog.mockResolvedValue(null);
    const mergeFeatureIntoBaseline = vi.fn(async () => ({ merged: true, conflicts: [] }));
    const runner = new QARunner(f.providers, config, {
      sandboxProvider: f.sandboxProvider,
      agentProvider: f.agentProvider,
      executionMode: 'batch',
      mergeFeatureIntoBaseline,
    });

    const result = await runner.process('60');

    expect(result).toMatchObject({ success: true });
    expect(f.providers.changes.merge).not.toHaveBeenCalled();
    expect(f.providers.backlog.transition).toHaveBeenCalledWith('60', 'merge_ready', expect.anything());
    expect(f.providers.backlog.transition).not.toHaveBeenCalledWith('60', 'done', expect.anything());
  });

  it('keeps declared baseline and target independent of an unmerged base backlog', async () => {
    const f = fixture();
    const child = { ...(await f.providers.backlog.get('60')), parentId: '10', baseBacklogId: '11', description: '## Base Version\n- Base Ref: release\n- Target Ref: production\n- Source Ref: migration' };
    const executionBase = { ...child, id: '11', title: 'stack base', parentId: undefined, baseBacklogId: undefined, state: 'verification', branchName: 'afk/backlog-11' };
    f.providers.backlog.get.mockImplementation(async (id: string) => id === '11' ? executionBase : child);
    const mergeFeatureIntoBaseline = vi.fn(async () => ({ merged: true, conflicts: [] }));
    const runner = new QARunner(f.providers, config, {
      sandboxProvider: f.sandboxProvider,
      agentProvider: f.agentProvider,
      executionMode: 'batch',
      mergeFeatureIntoBaseline,
    });

    await expect(runner.process('60')).resolves.toMatchObject({ success: true });

    expect(mergeFeatureIntoBaseline).toHaveBeenCalledWith(worktreePath, 'release', 'afk/backlog-60');
    expect(f.providers.changes.create).toHaveBeenCalledWith(expect.objectContaining({ targetBranch: 'production' }));
    expect(f.providers.backlog.get).not.toHaveBeenCalledWith('11');
  });
});

describe('QARunner workspace independence', () => {
  it('rebuilds a released workspace before creating the QA worktree and releases it afterwards', async () => {
    // implementation releases its checkout on success, so QA must not depend
    // on it: the repository root is gone by the time QA starts.
    const f = fixture();
    const order: string[] = [];
    const release = vi.fn(async () => { order.push('release'); });
    const workspace = {
      repositories: [],
      primary: { handle: { path: '/rebuilt/repo' } },
      finish: vi.fn(async () => {}),
      release,
    };
    const prepareRepositories = { prepare: vi.fn(async () => { order.push('prepare'); return workspace; }) };
    f.branches.createVerificationWorktree.mockImplementation(async () => {
      order.push('createVerificationWorktree');
      return { branchName: 'qa-60', worktreePath: worktreePath };
    });
    f.branches.cleanup.mockImplementation(async () => { order.push('cleanup'); });

    const runner = new QARunner(f.providers, config, {
      sandboxProvider: f.sandboxProvider,
      agentProvider: f.agentProvider,
      executionMode: 'batch',
      mergeFeatureIntoBaseline: vi.fn(async () => ({ merged: true, conflicts: [] })),
      projectRoot: '/workspace',
      repositories: [{ platform: 'github', projectKey: 'org/repo', repoRoot: '/workspace/repo', baseBranch: 'main', workingBranch: 'afk/backlog-60', primary: true }] as any,
      prepareRepositories: prepareRepositories as any,
      runtimeManager: { start: vi.fn(), heartbeat: vi.fn(), finish: vi.fn(), writeDiagnostics: vi.fn(), appendActivity: vi.fn() } as any,
    });

    const result = await runner.process('60');

    expect(result.success).toBe(true);
    expect(prepareRepositories.prepare).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ repoRoot: '/workspace/repo' })]),
      '/workspace',
    );
    expect(order).toEqual(['prepare', 'createVerificationWorktree', 'cleanup', 'release']);
    expect(workspace.finish).not.toHaveBeenCalled();
  });

  it('leaves unmanaged runs untouched when no managed workspace is configured', async () => {
    const f = fixture();
    const prepareRepositories = { prepare: vi.fn() };
    const runner = new QARunner(f.providers, config, {
      sandboxProvider: f.sandboxProvider,
      agentProvider: f.agentProvider,
      executionMode: 'batch',
      mergeFeatureIntoBaseline: vi.fn(async () => ({ merged: true, conflicts: [] })),
      prepareRepositories: prepareRepositories as any,
      runtimeManager: { start: vi.fn(), heartbeat: vi.fn(), finish: vi.fn(), writeDiagnostics: vi.fn(), appendActivity: vi.fn() } as any,
    });

    expect((await runner.process('60')).success).toBe(true);
    expect(prepareRepositories.prepare).not.toHaveBeenCalled();
  });
});
