import React from 'react';
import { renderToString } from 'ink';
import { describe, expect, it } from 'vitest';
import { BoardView } from './BoardView';
import type { BacklogViewModel } from '../data/backlog-adapter';
import { BacklogListView } from '../views/BacklogListView';
import { ProjectListView } from '../views/ProjectListView';
import { BacklogRow } from '../views/BacklogRow';

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

    expect(output).toContain('[verification]');
    expect(output).toContain('(hitl)');
    expect(output).not.toContain(backlog.description);
  });

  it('uses the canonical backlog row grammar', () => {
    const output = renderToString(
      <BacklogRow backlog={backlog} selected width={120} />,
    );

    expect(output).toContain('parent 10 · depends 1');
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

  it('renders canonical backlog state and execution mode', () => {
    const output = renderToString(
      <BoardView
        backlogs={[backlog]}
        selectedIndex={0}
        scrollOffset={0}
        viewportHeight={10}
        width={120}
      />,
    );

    expect(output).toContain('verification');
    expect(output).toContain('hitl');
    expect(output).toContain('backlog 42');
  });

  it('does not render a preview panel in the board subview', () => {
    const output = renderToString(
      <BoardView
        backlogs={[backlog]}
        selectedIndex={0}
        scrollOffset={0}
        viewportHeight={10}
        width={160}
      />,
    );

    expect(output).toContain('backlog 42');
    expect(output).not.toContain('preview');
  });
});
