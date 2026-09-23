import React from 'react';
import { renderToString } from 'ink';
import { describe, expect, it } from 'vitest';
import type { Project } from '../../../types/board';
import { ProjectListView } from './ProjectListView';

const project: Project = {
  id: 42,
  name: 'afk',
  path_with_namespace: 'easyhaloo/afk',
  namespace: { name: 'easyhaloo' },
  default_branch: 'main',
};

describe('ProjectListView', () => {
  it('renders project identity and the default branch in the row', () => {
    const output = renderToString(
      <ProjectListView projects={[project]} selected={0} scrollOffset={0} viewportHeight={4} width={100} />,
    );

    expect(output).toContain('[project] (main) #42 afk');
    expect(output).toContain('easyhaloo · main');
  });

  it('shows a placeholder when a project has no default branch', () => {
    const output = renderToString(
      <ProjectListView projects={[{ ...project, default_branch: undefined }]} selected={0} scrollOffset={0} viewportHeight={4} width={100} />,
    );

    expect(output).toContain('[project] (–) #42 afk');
  });
});
