import React from 'react';
import { renderToString } from 'ink';
import { describe, expect, it } from 'vitest';
import { BoardView } from './BoardView';
import type { BacklogViewModel } from '../data/backlog-adapter';
import { BacklogListView } from '../views/BacklogListView';
import { ProjectListView } from '../views/ProjectListView';
import { BacklogRow } from '../views/BacklogRow';
import { TaskListView } from '../views/TaskListView';

const backlog: BacklogViewModel = {
  id: '42',
  title: 'Fix API',
  description: 'Verify the request handling path.',
  state: 'verification',
  executionMode: 'hitl',
  parentId: '10',
  dependsOn: ['7'],
  tags: ['team:api'],
  branchName: 'afk/backlog-42',
  providerRef: 'github:org/repo#42',
  webUrl: 'https://example.test/42',
};

describe('BoardView', () => {
  it('does not render backlog description in a backlog list row', () => {
    const output = renderToString(
      <BacklogListView
        backlogs={[backlog]}
        selected={0}
        scrollOffset={0}
        viewportHeight={10}
        width={100}
      />,
    );

    expect(output).toContain('◌');
    expect(output).toContain('◇');
    expect(output).not.toContain('[verification]');
    expect(output).not.toContain('(hitl)');
    expect(output).not.toContain(backlog.description);
  });

  it('uses the canonical backlog row grammar', () => {
    const output = renderToString(
      <BacklogRow backlog={backlog} selected width={120} />,
    );

    expect(output).toContain('Fix API');
    expect(output).not.toContain('backlog 42');
    expect(output).not.toContain('parent 10');
  });

  it('uses compact icons rather than raw runtime state and mode text', () => {
    const output = renderToString(
      <TaskListView
        tasks={[{
          iid: '7', runId: 'run-7', title: 'Apply the selected backlog', phase: 'implementing',
          executionMode: 'batch', sandboxProvider: 'local', agentProvider: 'claude-code', status: 'active',
        }]}
        selected={0}
        scrollOffset={0}
        viewportHeight={10}
        width={100}
      />,
    );

    expect(output).toContain('●');
    expect(output).toContain('⚙');
    expect(output).not.toContain('active');
    expect(output).not.toContain('batch');
  });

  it('keeps a project title visible when its branch is very long', () => {
    const output = renderToString(
      <ProjectListView
        projects={[{
          id: 2,
          name: 'Dashboard',
          path_with_namespace: 'platform/dashboard',
          default_branch: 'feature/this-is-an-extremely-long-default-branch-name',
          namespace: { name: 'platform' },
        }]}
        selected={0}
        scrollOffset={0}
        viewportHeight={10}
        width={60}
      />,
    );

    expect(output).toContain('Dashboard');
  });

  it('keeps multiline project metadata on one row', () => {
    const output = renderToString(
      <ProjectListView
        projects={[{
          id: 1,
          name: 'Project\nDashboard',
          path_with_namespace: 'platform/dashboard',
          description: 'Compact\noperational metadata',
          default_branch: 'main',
          namespace: { name: 'platform' },
        }]}
        selected={0}
        scrollOffset={0}
        viewportHeight={10}
        width={160}
      />,
    );

    expect(output.trim()).not.toContain('\n');
    expect(output).toContain('Project Dashboard');
  });

  it('renders the kanban pipeline and selected card', () => {
    const output = renderToString(
      <BoardView
        backlogs={[backlog]}
        selectedIndex={0}
        scrollOffset={0}
        viewportHeight={10}
        width={120}
      />,
    );

    expect(output).toContain('flow');
    expect(output).toContain('◌');
    expect(output).toContain('◇');
    expect(output).toContain('#42');
    expect(output).toContain('Fix API');
  });

  it('renders named flow columns and persistent auxiliary summaries', () => {
    const allStates = [
      { ...backlog, id: 'ready', state: 'ready' as const },
      { ...backlog, id: 'processing', state: 'in_progress' as const },
      { ...backlog, id: 'merge', state: 'merge_ready' as const },
      { ...backlog, id: 'blocked', state: 'blocked' as const },
      { ...backlog, id: 'rework', state: 'rework' as const },
      { ...backlog, id: 'done', state: 'done' as const },
      backlog,
    ];
    const output = renderToString(
      <BoardView
        backlogs={allStates}
        selectedIndex={6}
        scrollOffset={0}
        viewportHeight={10}
        width={160}
      />,
    );

    expect(output).toContain('Ready 1');
    expect(output).toContain('Processing 1');
    expect(output).toContain('Verification 1');
    expect(output).toContain('Merge 1');
    expect(output).toContain('Attention 2');
    expect(output).toContain('Done 1');
  });

  it('uses compact labels to keep auxiliary counts visible on narrow terminals', () => {
    const output = renderToString(
      <BoardView
        backlogs={[
          { ...backlog, id: 'ready', state: 'ready' as const },
          { ...backlog, id: 'processing', state: 'in_progress' as const },
          { ...backlog, id: 'merge', state: 'merge_ready' as const },
          { ...backlog, id: 'blocked', state: 'blocked' as const },
          { ...backlog, id: 'rework', state: 'rework' as const },
          { ...backlog, id: 'done', state: 'done' as const },
          backlog,
        ]}
        selectedIndex={0}
        scrollOffset={0}
        viewportHeight={8}
        width={80}
      />,
    );

    expect(output).toContain('Alert 2');
    expect(output).toContain('Done 1');
  });

  it('clips board rows to the allocated viewport', () => {
    const output = renderToString(
      <BoardView
        backlogs={[backlog]}
        selectedIndex={0}
        scrollOffset={0}
        viewportHeight={2}
        width={120}
      />,
    );

    expect(output.trim().split('\n')).toHaveLength(2);
  });
});
