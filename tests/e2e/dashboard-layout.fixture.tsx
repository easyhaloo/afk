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

const backlogs = [
  {
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
  },
  {
    id: '43',
    title: 'Prepare implementation branch',
    description: 'fixture detail description',
    state: 'in_progress' as const,
    executionMode: 'afk' as const,
    parentId: '10',
    dependsOn: ['7'],
    tags: ['team:tui'],
    branchName: 'afk/backlog-43',
    providerRef: 'fixture:backlog#43',
    webUrl: 'https://example.test/backlogs/43',
  },
  {
    id: '44',
    title: 'Verify acceptance criteria',
    description: 'fixture detail description',
    state: 'verification' as const,
    executionMode: 'hitl' as const,
    parentId: '10',
    dependsOn: ['7'],
    tags: ['team:tui'],
    branchName: 'afk/backlog-44',
    providerRef: 'fixture:backlog#44',
    webUrl: 'https://example.test/backlogs/44',
  },
  {
    id: '45',
    title: 'Ready for human approval',
    description: 'fixture detail description',
    state: 'merge_ready' as const,
    executionMode: 'hitl' as const,
    parentId: '10',
    dependsOn: ['7'],
    tags: ['team:tui'],
    branchName: 'afk/backlog-45',
    providerRef: 'fixture:backlog#45',
    webUrl: 'https://example.test/backlogs/45',
  },
  {
    id: '46',
    title: 'Rework failing QA',
    description: 'fixture detail description',
    state: 'rework' as const,
    executionMode: 'afk' as const,
    parentId: '10',
    dependsOn: ['7'],
    tags: ['team:tui'],
    branchName: 'afk/backlog-46',
    providerRef: 'fixture:backlog#46',
    webUrl: 'https://example.test/backlogs/46',
  },
  {
    id: '47',
    title: 'Blocked by external dependency',
    description: 'fixture detail description',
    state: 'blocked' as const,
    executionMode: 'hitl' as const,
    parentId: '10',
    dependsOn: ['7'],
    tags: ['team:tui'],
    branchName: 'afk/backlog-47',
    providerRef: 'fixture:backlog#47',
    webUrl: 'https://example.test/backlogs/47',
  },
  {
    id: '48',
    title: 'Completed backlog',
    description: 'fixture detail description',
    state: 'done' as const,
    executionMode: 'afk' as const,
    parentId: '10',
    dependsOn: ['7'],
    tags: ['team:tui'],
    branchName: 'afk/backlog-48',
    providerRef: 'fixture:backlog#48',
    webUrl: 'https://example.test/backlogs/48',
  },
];

const projects = [{
  id: 9,
  platform: 'gitlab' as const,
  name: 'AFK E2E fixture',
  path_with_namespace: 'afk/e2e-fixture',
  description: 'Fixture project',
  default_branch: 'main',
  namespace: { name: 'afk' },
  web_url: 'https://example.test/projects/9',
}, {
  id: 9,
  platform: 'github' as const,
  name: 'AFK GitHub fixture',
  path_with_namespace: 'afk/github-fixture',
  description: 'GitHub fixture project',
  default_branch: 'main',
  namespace: { name: 'afk' },
  web_url: 'https://github.example/projects/9',
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
