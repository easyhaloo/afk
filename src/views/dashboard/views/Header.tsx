import React from 'react';
import { Box, Text } from 'ink';

interface Props {
  view: string;
  tasksCount: number;
  issuesCount: number;
  projectsCount: number;
  selectedIssuesCount: number;
  multiSelectMode: boolean;
}

export function Header({
  view, tasksCount, issuesCount, projectsCount,
  selectedIssuesCount, multiSelectMode,
}: Props) {
  const icon = view === 'tasks' ? '●' : view === 'issues' ? '○'
    : view === 'board' ? '▦' : '▸';
  const count = view === 'tasks' ? tasksCount
    : view === 'issues' ? issuesCount
    : view === 'board' ? issuesCount
    : projectsCount;

  return (
    <Box height={1} flexShrink={0} paddingX={2} backgroundColor="black" justifyContent="space-between">
      <Text color="white"><Text bold>▸ AFK Dashboard</Text></Text>
      <Text color="white">
        <Text>{icon}</Text>
        <Text> {view} </Text>
        <Text>{count}</Text>
        {view === 'issues' && multiSelectMode && (
          <Text dimColor> ({selectedIssuesCount})</Text>
        )}
      </Text>
    </Box>
  );
}
