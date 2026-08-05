import React from 'react';
import { Box, render } from 'ink';
import { AppContent } from '../../src/views/app/AppContent';
import { StateProvider } from '../../src/views/app/state/StateContext';

const tasks = [{
  iid: 17,
  title: 'Exercise responsive task navigation',
  status: 'active' as const,
  session: 'afk-e2e-task',
  branch: 'afk/e2e-layout',
  progress: '50%',
  worktree: '/tmp/afk-e2e-layout',
}];

const backlogs = [{
  id: '42',
  title: 'Render backlog detail in a subview',
  description: 'fixture detail description',
  state: 'ready' as const,
  executionMode: 'afk' as const,
  parentId: '10',
  dependsOn: ['7'],
  tags: ['team:tui'],
  branchName: 'afk/backlog-42',
  providerRef: 'fixture:backlog#42',
  webUrl: 'https://example.test/backlogs/42',
}];

const projects = [{
  id: 9,
  name: 'AFK E2E fixture',
  path_with_namespace: 'afk/e2e-fixture',
  description: 'Fixture project',
  default_branch: 'main',
  namespace: { name: 'afk' },
  web_url: 'https://example.test/projects/9',
}];

function DashboardFixture() {
  return (
    <Box flexDirection="column">
      <StateProvider>
        <AppContent
          tasks={tasks}
          backlogs={backlogs}
          projects={projects}
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
      </StateProvider>
    </Box>
  );
}

render(<DashboardFixture />, { exitOnCtrlC: true, patchConsole: false });
