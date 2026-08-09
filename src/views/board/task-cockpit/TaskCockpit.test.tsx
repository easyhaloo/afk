import React from 'react';
import { renderToString } from 'ink';
import { describe, expect, it } from 'vitest';
import type { Task } from '../../../types/board';
import { TaskCockpit } from './TaskCockpit';

const activeTask: Task = {
  iid: '42',
  runId: 'run-42',
  title: 'Add /s search mode to the backlog list',
  phase: 'implementing',
  executionMode: 'batch',
  sandboxProvider: 'local',
  agentProvider: 'claude-code',
  branch: 'afk/backlog-42',
  worktree: '/tmp/afk-42',
  status: 'active',
  progress: '64%',
  startedAt: new Date('2026-08-09T10:00:00.000Z'),
  heartbeatAt: new Date('2026-08-09T10:08:00.000Z'),
  activities: [
    { id: 'event-1', taskRunId: 'run-42', at: new Date('2026-08-09T10:07:00.000Z'), kind: 'tool', message: 'edited ListView.tsx' },
    { id: 'event-2', taskRunId: 'run-42', at: new Date('2026-08-09T10:08:00.000Z'), kind: 'test', message: '4 passed · 0 failed' },
  ],
};

describe('TaskCockpit', () => {
  it('shows focused execution context, structured activity, and the task queue', () => {
    const output = renderToString(
      <TaskCockpit
        tasks={[activeTask, { ...activeTask, iid: '43', runId: 'run-43', title: 'Verify acceptance criteria', status: 'active' }]}
        selectedIndex={0}
        viewportHeight={18}
        width={120}
      />,
    );

    expect(output).toContain('#42');
    expect(output).toContain('Add /s search mode');
    expect(output).toContain('processing');
    expect(output).toContain('64%');
    expect(output).toContain('tool');
    expect(output).toContain('edited ListView.tsx');
    expect(output).toContain('test');
    expect(output).toContain('#43');
  });

  it('collapses the queue on narrow terminals while keeping a queued count', () => {
    const output = renderToString(
      <TaskCockpit
        tasks={[activeTask, { ...activeTask, iid: '43', runId: 'run-43', title: 'Verify acceptance criteria' }]}
        selectedIndex={0}
        viewportHeight={10}
        width={70}
      />,
    );

    expect(output).toContain('+1 queued');
    expect(output).not.toContain('#43');
  });

  it('uses terminal width rather than padded content width for responsive layout', () => {
    const output = renderToString(
      <TaskCockpit
        tasks={[activeTask, { ...activeTask, iid: '43', runId: 'run-43', title: 'Queued task' }]}
        selectedIndex={0}
        viewportHeight={12}
        width={76}
        terminalWidth={80}
      />,
    );

    expect(output).toContain('#43');
    expect(output).not.toContain('+1 queued');
  });

  it('omits the narrow queue summary when no other task is queued', () => {
    const output = renderToString(
      <TaskCockpit
        tasks={[activeTask]}
        selectedIndex={0}
        viewportHeight={10}
        width={70}
      />,
    );

    expect(output).not.toContain('queued');
  });

  it('gives the focused task the full wide layout when the queue is empty', () => {
    const output = renderToString(
      <TaskCockpit
        tasks={[activeTask]}
        selectedIndex={0}
        viewportHeight={12}
        width={120}
      />,
    );

    expect(output).not.toContain('queue 0');
    expect(output).not.toContain('no other tasks');
  });

  it('surfaces stale semantics without relying on color alone', () => {
    const output = renderToString(
      <TaskCockpit
        tasks={[{ ...activeTask, status: 'stale' }]}
        selectedIndex={0}
        viewportHeight={12}
        width={100}
      />,
    );

    expect(output).toContain('stale');
  });

  it('marks active runtimes with errors as attention instead of healthy', () => {
    const output = renderToString(
      <TaskCockpit tasks={[{ ...activeTask, errorSummary: 'tests failed' }]} selectedIndex={0} viewportHeight={12} width={100} />,
    );

    expect(output).toContain('! error · processing');
    expect(output).not.toContain('● active');
  });

  it('does not render orphan separators when runtime metadata is unavailable', () => {
    const output = renderToString(
      <TaskCockpit
        tasks={[{
          iid: '44',
          runId: 'run-44',
          title: 'Runtime metadata is still loading',
          status: 'active',
        } as Task]}
        selectedIndex={0}
        viewportHeight={10}
        width={70}
      />,
    );

    expect(output).not.toMatch(/\n\s*·(?:\s*·)?\s*\n/);
    expect(output).not.toContain('branch –');
  });

  it('shows session context and tolerates an invalid activity timestamp', () => {
    const output = renderToString(
      <TaskCockpit
        tasks={[{
          ...activeTask,
          branch: undefined,
          worktree: undefined,
          session: 'afk-42-session',
          activities: [{ ...activeTask.activities![0]!, at: new Date('invalid') }],
        }]}
        selectedIndex={0}
        viewportHeight={12}
        width={100}
      />,
    );

    expect(output).toContain('session afk-42-session');
    expect(output).toContain('--:--');
  });

  it('renders an explicit empty runtime state', () => {
    const output = renderToString(<TaskCockpit tasks={[]} selectedIndex={0} viewportHeight={8} width={80} />);

    expect(output).toContain('no running tasks');
    expect(output).toContain('refresh');
  });
});
