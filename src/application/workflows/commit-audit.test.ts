import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { simpleGit } from 'simple-git';
import type { RunEvent } from '@afk/core';
import type { AgentExecution, AgentExecutionOptions, AgentProvider } from '../../domain/agents/types.js';
import { createAgentProvider } from '../../domain/agents/index.js';
import type { BacklogClaim, BacklogItem } from '../../domain/backlog/index.js';
import { TemplateLoader } from '../../domain/templates/loader.js';
import { JsonlEventStore } from '../../infrastructure/observability/jsonl-event-store.js';
import type { ProviderBundle } from '../../infrastructure/provider/providers.js';
import type { Sandbox, SandboxProvider } from '../../infrastructure/sandbox/types.js';
import { RunObserver } from '../../observability/run-observer.js';
import { WorkflowRunner } from '../workflow-engine.js';
import { BudgetStore } from './budget-store.js';

vi.mock('../modules/project-resolver', () => ({ default: () => ({ name: 'project-resolver' }) }));

let directory: string;
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'afk-commit-audit-')); });
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true }); });

async function readEvents(store: JsonlEventStore, runId: string): Promise<RunEvent[]> {
  const events: RunEvent[] = [];
  for await (const event of store.read(runId)) events.push(event);
  return events;
}

describe('WorkflowRunner default template commit audit', () => {
  it.each([
    { createsCommit: true, codexOverride: false, sandboxName: 'local' as const, scenario: 'records the full local implementation SHA at publish' },
    { createsCommit: false, codexOverride: false, sandboxName: 'local' as const, scenario: 'does not record a baseline or agent-reported SHA without a new commit' },
    { createsCommit: false, codexOverride: true, sandboxName: 'local' as const, scenario: 'records native telemetry and budget for a Codex step in a Claude workflow' },
    { createsCommit: false, codexOverride: false, sandboxName: 'docker' as const, scenario: 'records normalized container telemetry and budget without host transcripts' },
  ])('$scenario', async ({ createsCommit, codexOverride, sandboxName }) => {
    const repoRoot = join(directory, 'repository');
    const worktreePath = join(directory, 'implementation');
    const runId = 'commit-audit-42';
    const workItemId = 'github:acme/api#42';
    const fakeSha = 'f'.repeat(40);
    vi.stubEnv('HOME', directory);
    await mkdir(repoRoot);
    const git = simpleGit({ baseDir: repoRoot, unsafe: { allowUnsafeHooksPath: true } });
    await git.raw(['init', '--initial-branch=main', '--object-format=sha1']);
    await git.addConfig('user.name', 'Commit Audit Test');
    await git.addConfig('user.email', 'commit-audit@example.test');
    await git.addConfig('commit.gpgsign', 'false');
    await git.addConfig('core.hooksPath', join(directory, 'empty-hooks'));
    await writeFile(join(repoRoot, 'baseline.txt'), 'baseline\n');
    await git.add('baseline.txt');
    await git.commit('fixture baseline');
    const baselineSha = (await git.revparse(['HEAD'])).trim();

    const loaded = await new TemplateLoader({ projectRoot: repoRoot }).loadWithSource('issue-implementation');
    expect(loaded.source).toBe('builtin');
    expect(loaded.template.steps.map(step => step.id)).toEqual(['implement', 'verify-ac', 'publish', 'queue-qa']);
    const nativeSessionId = 'codex-step-session';
    const rolloutPath = join(directory, '.codex', 'sessions', '2026', '10', '18', `rollout-test-${nativeSessionId}.jsonl`);
    const hostTranscriptPath = join(directory, 'host-transcript.jsonl');
    if (sandboxName === 'docker') await writeFile(hostTranscriptPath, JSON.stringify({ session_id: 'unrelated-host-session' }));
    if (codexOverride) {
      await mkdir(join(repoRoot, '.afk', 'workflows'), { recursive: true });
      await writeFile(join(repoRoot, '.afk', 'workflows', 'issue-implementation.yaml'), JSON.stringify({
        ...loaded.template,
        defaultBranch: undefined,
        steps: loaded.template.steps.map(step => ({ ...step, branch: undefined, ...(step.id === 'implement' ? { provider: 'codex' } : {}) })),
      }));
      await mkdir(join(directory, '.codex', 'sessions', '2026', '10', '18'), { recursive: true });
      await writeFile(rolloutPath, [
        { type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } } } },
        { type: 'item.completed', item: { id: 'tool-1', type: 'command_execution', exit_code: 2 } },
      ].map(event => JSON.stringify(event)).join('\n'));
    }

    const item: BacklogItem = {
      id: '42', title: 'Commit audit regression', dependsOn: [], state: 'in_progress', executionMode: 'afk',
      branchName: 'afk/backlog-42', providerRef: 'github:acme/api#42',
    };
    const claim: BacklogClaim = {
      item, claimId: 'claim-42', heartbeat: vi.fn(async () => undefined), release: vi.fn(async () => undefined),
    };
    const store = new JsonlEventStore({ root: join(directory, 'events') });
    let eventsAtPush: RunEvent[] = [];
    const providers = {
      backlog: {
        claim: vi.fn(async () => claim), transition: vi.fn(async () => undefined),
        setExecutionMode: vi.fn(async () => undefined), get: vi.fn(async () => item), list: vi.fn(async () => []),
        isRunnable: vi.fn(async () => true), getActiveRework: vi.fn(async () => undefined),
      },
      branches: {
        createBranch: vi.fn(async (backlog: BacklogItem, baseBranch: string) => {
          await git.raw(['worktree', 'add', '-b', backlog.branchName, worktreePath, baseBranch]);
          return { branchName: backlog.branchName, worktreePath };
        }),
        createVerificationWorktree: vi.fn(),
        push: vi.fn(async () => { eventsAtPush = await readEvents(store, runId); }),
        commit: vi.fn(), cleanup: vi.fn(async () => undefined),
      },
      changes: { create: vi.fn(), get: vi.fn(), findForBacklog: vi.fn(), merge: vi.fn(), close: vi.fn() },
    } as unknown as ProviderBundle;
    const sandbox: Sandbox = {
      id: 'sandbox-42', worktreePath, workspacePath: directory,
      startAgent: vi.fn(), close: vi.fn(async () => undefined),
    };
    const sandboxProvider: SandboxProvider = {
      name: sandboxName, isolation: 'workspace', capabilities: new Set(), createWorktree: vi.fn(),
      create: vi.fn(async () => sandbox),
    };
    const agent: AgentProvider = {
      name: 'claude-code', capabilities: new Set(),
      createExecution: vi.fn(async (options: AgentExecutionOptions) => {
        const implementing = options.sessionId.endsWith('-implement');
        const execution: AgentExecution = {
          id: options.sessionId, metadata: {
            provider: implementing && codexOverride ? 'codex' : 'claude-code', transport: 'process',
            ...(implementing && codexOverride ? { threadId: nativeSessionId } : {}),
          },
          ...(sandboxName === 'docker' ? { telemetryPath: hostTranscriptPath } : {}),
          waitForEvent: vi.fn(async () => null),
          waitForResult: vi.fn(async () => {
            if (implementing && createsCommit) {
              await writeFile(join(options.worktreePath, 'implementation.txt'), 'implemented\n');
              const worktreeGit = simpleGit(options.worktreePath);
              await worktreeGit.add('implementation.txt');
              await worktreeGit.commit('fixture implementation');
            }
            return {
              version: 1 as const, runId: options.sessionId, status: 'completed' as const, provider: 'test', commits: [fakeSha],
              usage: sandboxName === 'docker' ? { inputTokens: 10, outputTokens: 5, totalTokens: 15 } : undefined,
              tools: implementing && codexOverride ? undefined : [{ id: 'tool-1', name: 'Bash', result: 'failed' as const, exitCode: 2 }],
              structuredOutput: implementing
                ? { type: 'goal_complete', kind: 'task', summary: 'implemented' }
                : { type: 'goal_complete', kind: 'ac_verification', result: 'PASS', summary: 'verified' },
            };
          }),
          interrupt: vi.fn(async () => undefined), kill: vi.fn(async () => undefined),
          captureOutput: vi.fn(async () => ''), captureSession: vi.fn(async () => undefined),
          resume: vi.fn(async () => { throw new Error('unsupported'); }),
        };
        return execution;
      }),
    };
    if (codexOverride) vi.spyOn(createAgentProvider('codex'), 'createExecution').mockImplementation(options => agent.createExecution(options));
    const runner = new WorkflowRunner(providers, {
      agentProvider: agent, sandboxProvider, observer: new RunObserver({ events: store }),
      watchdog: { arm: vi.fn(), disarm: vi.fn() } as never,
      runtimeManager: {
        start: vi.fn(async () => undefined), heartbeat: vi.fn(async () => undefined), finish: vi.fn(async () => undefined),
        writeDiagnostics: vi.fn(async () => undefined), appendActivity: vi.fn(async () => undefined),
      } as never,
    });

    await expect(runner.run({
      backlogId: item.id, session: 'worker-42', targetBranch: item.branchName, baseBranch: 'main',
      repoRoot, workspaceRoot: directory, executionMode: 'batch',
      observationRunId: runId, observationWorkItemId: workItemId,
    })).resolves.toEqual({ success: true });

    const head = (await simpleGit(worktreePath).revparse(['HEAD'])).trim();
    const events = await readEvents(new JsonlEventStore({ root: store.root }), runId);
    const sessions = events.filter(event => event.type === 'agent.session_recorded');
    expect(sessions).toHaveLength(2);
    for (const [index, event] of sessions.entries()) {
      expect(event.data).toMatchObject({ tools: [{ id: 'tool-1', name: codexOverride && index === 0 ? 'command_execution' : 'Bash', result: 'failed', exitCode: 2 }] });
    }
    if (codexOverride || sandboxName === 'docker') {
      expect(sessions[0]?.data).toMatchObject({ usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } });
      expect(await new BudgetStore(directory, workItemId).load()).toMatchObject({ tokens: codexOverride ? 15 : 30 });
      if (codexOverride) {
        expect(sessions[0]?.data).toMatchObject({ sessionId: nativeSessionId, transcriptPath: rolloutPath });
        expect(await new BudgetStore(directory, workItemId).load()).toMatchObject({ sessions: { [nativeSessionId]: 15 } });
      } else {
        expect(sessions.every(event => !('transcriptPath' in event.data))).toBe(true);
      }
    }
    const commits = events.filter(event => event.type === 'commit.recorded');
    expect(head).toMatch(/^[0-9a-f]{40}$/);
    expect(head).not.toBe(fakeSha);
    expect(providers.branches.createBranch).toHaveBeenCalledWith(item, 'main');
    expect(agent.createExecution).toHaveBeenCalledTimes(2);
    expect(vi.mocked(agent.createExecution).mock.calls.map(([options]) => options.sessionId))
      .toEqual(['worker-42-implement', 'worker-42-verify-ac']);
    expect(eventsAtPush.filter(event => event.type === 'step.completed').map(event => event.data))
      .toEqual([
        { kind: 'step.completed', stepId: 'implement', outcome: 'succeeded' },
        { kind: 'step.completed', stepId: 'verify-ac', outcome: 'succeeded' },
      ]);
    expect(providers.branches.push).toHaveBeenCalledTimes(1);
    expect(providers.branches.push).toHaveBeenCalledWith(item.branchName, worktreePath);
    expect(providers.backlog.transition).toHaveBeenCalledWith(item.id, 'verification', undefined);
    expect(providers.branches.commit).not.toHaveBeenCalled();
    expect(providers.changes.create).not.toHaveBeenCalled();
    expect(claim.release).toHaveBeenCalledTimes(1);
    expect(events.find(event => event.type === 'implementation.completed')?.data)
      .toEqual({ kind: 'implementation.completed' });

    if (createsCommit) {
      expect(head).not.toBe(baselineSha);
      expect(commits).toHaveLength(1);
      expect(commits[0]).toMatchObject({
        context: { runId, workItemId },
        data: { kind: 'commit.recorded', phase: 'implementation', commitSha: head, branch: item.branchName },
      });
      expect(eventsAtPush.filter(event => event.type === 'commit.recorded')).toEqual(commits);
    } else {
      expect(head).toBe(baselineSha);
      expect(commits).toEqual([]);
      expect(eventsAtPush.filter(event => event.type === 'commit.recorded')).toEqual([]);
    }
    await expect(store.verify(runId)).resolves.toMatchObject({ valid: true });
  });
});
