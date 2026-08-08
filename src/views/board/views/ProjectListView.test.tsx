import React from 'react';
import { renderToString } from 'ink';
import { describe, expect, it } from 'vitest';
import type { Project } from '../../../lib/core/tracker/types';
import { ProjectListView, getBranchColor, getProjectPlatformIcon } from './ProjectListView';

const githubProject: Project = {
  id: 42,
  platform: 'github',
  name: 'afk',
  path_with_namespace: 'easyhaloo/afk',
  namespace: { name: 'easyhaloo' },
  default_branch: 'main',
};

describe('ProjectListView', () => {
  it('renders a provider icon and keeps the branch visible in the row', () => {
    const output = renderToString(
      <ProjectListView projects={[githubProject]} selected={0} scrollOffset={0} viewportHeight={4} width={100} />,
    );

    expect(output).toContain('GH');
    expect(output).toContain('afk');
    expect(output).toContain('main');
  });

  it('uses distinct colors for default, feature, and missing branches', () => {
    expect(getBranchColor('main', 'main')).toBe('green');
    expect(getBranchColor('feature/search', 'main')).toBe('blue');
    expect(getBranchColor('–', 'main')).toBe('yellow');
    expect(getProjectPlatformIcon('github')).toBe('GH');
    expect(getProjectPlatformIcon('gitlab')).toBe('GL');
  });
});
