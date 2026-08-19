import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ClaudeCodeProvider } from '../../domain/agents/claude-code';
import { LocalSandboxProvider } from '../../infrastructure/sandbox/providers/local';
import { buildExecutionPrompt } from '../workflows/execution-protocol';
import { fetchTasks } from '../../views/board/data/fetcher';
import { TaskRuntimeManager, TaskRuntimeStore } from './task-runtime';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe.runIf(process.env.AFK_REAL_CLAUDE_E2E === '1')('task runtime monitor integration', () => {
  it('tracks a real Claude Code batch run from agent output through the Tasks read model', async () => {
    const root = await mkdtemp(join(tmpdir(), 'afk-runtime-integration-'));
    temporaryRoots.push(root);
    const workspace = join(root, 'workspace');
    await mkdir(workspace);

    const runId = 'integration-run';
    const manager = new TaskRuntimeManager(new TaskRuntimeStore(join(root, 'runtime')));
    const now = new Date().toISOString();
    await manager.start({
      runId,
      backlogId: 'INT-42',
      title: 'Exercise runtime monitor',
      phase: 'implementing',
      status: 'running',
      sandboxProvider: 'local',
      executionMode: 'batch',
      agentProvider: 'claude-code',
      worktree: workspace,
      branch: 'afk/backlog-INT-42',
      startedAt: now,
      heartbeatAt: now,
    });

    const agent = new ClaudeCodeProvider();
    const sandbox = await new LocalSandboxProvider().create({
      worktreePath: workspace,
      session: 'integration-session',
      executionMode: 'batch',
    });

    try {
      const execution = await agent.createExecution({
        sandbox,
        worktreePath: workspace,
        sessionId: 'integration-session',
        generation: 1,
        prompt: buildExecutionPrompt('/goal Do not use tools or modify files. Confirm that the isolated sandbox is available, then complete the task.', 'batch', 'task'),
        signalType: 'goal_complete',
        executionMode: 'batch',
      });
      const result = await execution.waitForResult({ completionTimeoutMs: 30_000 });
      const output = await execution.captureOutput();
      await manager.writeDiagnostics(runId, { result, output });
      await manager.heartbeat(runId, { progress: 'agent completed' });

      expect(result).toMatchObject({ status: 'completed', structuredOutput: { type: 'goal_complete' } });
      await expect(fetchTasks(manager)).resolves.toEqual({
        active: [expect.objectContaining({
          iid: 'INT-42', runId, status: 'active', executionMode: 'batch', progress: 'agent completed',
        })],
        completed: [],
      });
      const active = await manager.listActive();
      await expect(readFile(join(active[0]!.diagnosticPath!, 'result.json'), 'utf8')).resolves.toContain('"status": "completed"');
      await expect(readFile(join(active[0]!.diagnosticPath!, 'output.log'), 'utf8')).resolves.toContain('goal_complete');

      await manager.finish(runId, { status: 'completed', progress: 'finished' });
      await expect(fetchTasks(manager)).resolves.toEqual({ active: [], completed: [] });
    } finally {
      await sandbox.close();
    }
  });
});
