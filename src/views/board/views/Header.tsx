import React from 'react';
import { Box, Text } from 'ink';
import type { View } from '../types';

interface Props {
  view: View;
  tasksCount: number;
  backlogsCount: number;
  projectsCount: number;
  runningCount?: number;
  attentionCount?: number;
  width?: number;
}

export function Header({ view, tasksCount, backlogsCount, projectsCount, runningCount, attentionCount, width }: Props) {
  const compact = (width || process.stdout.columns || 80) < 100;
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
    <Box width={width} height={1} flexShrink={0} overflow="hidden" flexDirection="column" backgroundColor="black">
      <Box height={1} paddingX={2} justifyContent="space-between" overflow="hidden">
        <Text color="white" wrap="truncate">
          <Text bold>{compact ? '▸ AFK' : '▸ AFK Dashboard'}</Text>
          {runningCount !== undefined && <>
            <Text dimColor> · </Text>
            <Text color="cyan">{compact ? `●${runningCount}` : `●${runningCount} running`}</Text>
            <Text dimColor> · </Text>
            <Text color={attentionCount ? 'red' : 'gray'}>{compact ? `!${attentionCount ?? 0}` : `!${attentionCount ?? 0} attention`}</Text>
          </>}
        </Text>
        <Text color="white" wrap="truncate">
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
    </Box>
  );
}
