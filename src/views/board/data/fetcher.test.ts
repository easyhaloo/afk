import { describe, expect, it } from 'vitest';
import type { Project } from '../../../lib/core/tracker/types';
import { mergeProjects, projectDetailKey, toRuntimeTask } from './fetcher';
import type { ActiveTaskRuntimeRecord } from '../../../lib/runtime/task-runtime';

function project(id: number, platform: Project['platform'], path: string): Project {
  return {
    id,
    platform,
    name: path.split('/').at(-1) ?? path,
    path_with_namespace: path,
    namespace: { name: path.split('/')[0] ?? '' },
    default_branch: 'main',
  };
}

describe('project dashboard data', () => {
  it('keeps projects from both GitLab and GitHub providers', () => {
    const merged = mergeProjects([
      project(1, 'gitlab', 'group/gitlab-app'),
      project(2, 'github', 'org/github-app'),
    ]);

    expect(merged.map(item => `${item.platform}:${item.path_with_namespace}`)).toEqual([
      'gitlab:group/gitlab-app',
      'github:org/github-app',
    ]);
  });

  it('uses provider-qualified detail cache keys', () => {
    expect(projectDetailKey(project(42, 'gitlab', 'group/app'))).toBe('gitlab:42');
    expect(projectDetailKey(project(42, 'github', 'org/app'))).toBe('github:42');
  });
});

describe('runtime task data', () => {
  it('maps structured runtime activity into the task read model', () => {
    const at = '2026-08-09T10:20:30.000Z';
    const runtime: ActiveTaskRuntimeRecord = {
      runId: 'run-42',
      backlogId: '42',
      title: 'Add search',
      phase: 'implementing',
      status: 'running',
      sandboxProvider: 'local',
      executionMode: 'batch',
      agentProvider: 'claude-code',
      startedAt: at,
      heartbeatAt: at,
      activities: [{ id: 'event-1', taskRunId: 'run-42', at, kind: 'tool', message: 'edited ListView.tsx' }],
    };

    const task = toRuntimeTask(runtime);

    expect(task.activities).toEqual([{ id: 'event-1', taskRunId: 'run-42', at: new Date(at), kind: 'tool', message: 'edited ListView.tsx' }]);
  });
});
