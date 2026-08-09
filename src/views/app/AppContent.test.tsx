import React from 'react';
import { renderToString } from 'ink';
import { afterEach, describe, expect, it } from 'vitest';
import { AppContent } from './AppContent';
import { StateProvider } from './state/StateContext';
import type { Task } from '../../types/board';

const originalColumns = process.stdout.columns;
const originalRows = process.stdout.rows;

function task(index: number): Task {
  return {
    iid: String(index),
    runId: `run-${index}`,
    title: `Long-running task ${index}`,
    phase: 'implementing',
    executionMode: 'batch',
    sandboxProvider: 'local',
    agentProvider: 'claude-code',
    status: 'active',
  };
}

afterEach(() => {
  Object.defineProperty(process.stdout, 'columns', { configurable: true, value: originalColumns });
  Object.defineProperty(process.stdout, 'rows', { configurable: true, value: originalRows });
});

describe('AppContent', () => {
  it('uses the live task cockpit as the default task body', () => {
    Object.defineProperty(process.stdout, 'columns', { configurable: true, value: 100 });
    Object.defineProperty(process.stdout, 'rows', { configurable: true, value: 16 });

    const output = renderToString(
      <StateProvider>
        <AppContent
          tasks={[task(1)]}
          backlogs={[]}
          projects={[]}
          projectBranches={[]}
          projectTags={[]}
          projectCommits={[]}
          projectHasMore={false}
          onLoadProjectDetail={() => {}}
          onReloadTasks={() => {}}
          onReloadBacklogs={() => {}}
          onFetchMoreProjects={() => {}}
          onInvalidateDetailCache={() => {}}
        />
      </StateProvider>,
    );

    expect(output).toContain('recent activity');
    expect(output).not.toContain('no other tasks');
  });

  it('keeps static list commands in the footer instead of repeating them above the content', () => {
    Object.defineProperty(process.stdout, 'columns', { configurable: true, value: 100 });
    Object.defineProperty(process.stdout, 'rows', { configurable: true, value: 12 });

    const output = renderToString(
      <StateProvider>
        <AppContent
          tasks={[task(1)]}
          backlogs={[]}
          projects={[]}
          projectBranches={[]}
          projectTags={[]}
          projectCommits={[]}
          projectHasMore={false}
          onLoadProjectDetail={() => {}}
          onReloadTasks={() => {}}
          onReloadBacklogs={() => {}}
          onFetchMoreProjects={() => {}}
          onInvalidateDetailCache={() => {}}
        />
      </StateProvider>,
    );

    expect(output.match(/enter detail/g)).toHaveLength(1);
  });

  it('keeps the header and footer visible when the task list exceeds the viewport', () => {
    Object.defineProperty(process.stdout, 'columns', { configurable: true, value: 100 });
    Object.defineProperty(process.stdout, 'rows', { configurable: true, value: 12 });

    const output = renderToString(
      <StateProvider>
        <AppContent
          tasks={Array.from({ length: 30 }, (_, index) => task(index + 1))}
          backlogs={[]}
          projects={[]}
          projectBranches={[]}
          projectTags={[]}
          projectCommits={[]}
          projectHasMore={false}
          onLoadProjectDetail={() => {}}
          onReloadTasks={() => {}}
          onReloadBacklogs={() => {}}
          onFetchMoreProjects={() => {}}
          onInvalidateDetailCache={() => {}}
        />
      </StateProvider>,
    ).trimEnd().split('\n');

    expect(output[0]).toContain('AFK Dashboard');
    expect(output.at(-1)).toContain('move');
    expect(output).not.toContain(expect.stringContaining('Long-running task 30'));
  });
});
