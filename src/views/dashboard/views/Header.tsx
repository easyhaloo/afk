import React from 'react';
import { Box, Text } from 'ink';
import type { View } from '../../../lib/dashboard/types';

interface Props {
  view: View;
  tasksCount: number;
  issuesCount: number;
  completedCount: number;
  projectsCount: number;
  selectedIssuesCount: number;
  multiSelectMode: boolean;
}

export function Header({
  view, tasksCount, issuesCount, completedCount, projectsCount,
  selectedIssuesCount, multiSelectMode,
}: Props) {
  const icon = view === 'tasks' ? '●' : view === 'issues' ? '○'
    : view === 'completed' ? '✔' : '▸';
  const count = view === 'tasks' ? tasksCount
    : view === 'issues' ? issuesCount
    : view === 'completed' ? completedCount
    : projectsCount;

  return (
    <Box height={1} flexShrink={0} paddingX={2} backgroundColor="black" justifyContent="space-between">
      <Text color="white"><Text bold>▸ AFK Dashboard</Text></Text>
      <Text color="white">
        <Text>{icon}</Text>
        <Text> {view === 'completed' ? 'done' : view} </Text>
        <Text>{count}</Text>
        {view === 'issues' && multiSelectMode && (
          <Text dimColor> ({selectedIssuesCount})</Text>
        )}
      </Text>
    </Box>
  );
}
