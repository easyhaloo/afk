import React from 'react';
import { Box, Text } from 'ink';
import type { View } from '../types';

interface Props {
  view: View;
  tasksCount: number;
  backlogsCount: number;
  projectsCount: number;
}

export function Header({ view, tasksCount, backlogsCount, projectsCount }: Props) {
  const counts: Record<View, number> = {
    tasks: tasksCount,
    backlogs: backlogsCount,
    projects: projectsCount,
    board: backlogsCount,
  };
  const tabs: ReadonlyArray<readonly [string, View]> = [
    ['1', 'tasks'],
    ['2', 'backlogs'],
    ['3', 'projects'],
    ['4', 'board'],
  ] as const;

  return (
    <Box height={1} flexShrink={0} paddingX={2} backgroundColor="black" justifyContent="space-between">
      <Text color="white"><Text bold>▸ AFK Dashboard</Text></Text>
      <Text color="white">
        {tabs.map(([key, name], index) => {
          const active = view === name;
          return (
            <React.Fragment key={name}>
              {index > 0 && <Text color="gray"> │ </Text>}
              <Text bold={active} color={active ? 'cyan' : 'white'}>
                {key} {name}{active ? ` ${counts[name]}` : ''}
              </Text>
            </React.Fragment>
          );
        })}
      </Text>
    </Box>
  );
}
