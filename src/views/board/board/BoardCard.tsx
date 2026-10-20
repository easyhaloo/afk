import React from 'react';
import { Box, Text } from 'ink';
import type { BacklogViewModel } from '../data/backlog-adapter.js';
import { backlogStateColor } from '../views/BacklogRow.js';
import { getExecutionModeColor, getExecutionModeIcon, getStatusIcon } from '../views/display.js';

import { displayWidth, truncateByWidth } from '../../shared/display-width.js';

export interface BoardCardProps {
  backlog: BacklogViewModel;
  selected: boolean;
  width: number;
}

export function BoardCard({ backlog, selected, width }: BoardCardProps) {
  const stateColor = backlogStateColor(backlog.state);
  const runtimeSummary = [backlog.phase, backlog.progress].filter(Boolean).join(' · ');
  const title = truncateByWidth(
    runtimeSummary ? `${runtimeSummary} · ${backlog.title}` : backlog.title,
    Math.max(1, width - 2),
  );

  return (
    <Box width={width} height={2} overflow="hidden" flexDirection="column">
      <Text color={selected ? 'white' : stateColor} wrap="truncate">
        {selected ? '▶ ' : '  '}
        <Text color={stateColor}>{getStatusIcon(backlog.state)}</Text>
        <Text bold> #{backlog.id}</Text>
        <Text color={getExecutionModeColor(backlog.executionMode)}> {getExecutionModeIcon(backlog.executionMode)}</Text>
        <Text dimColor> · {backlog.state} · {backlog.runStatus ?? 'no-runtime'}</Text>
      </Text>
      <Text wrap="truncate" bold={selected}>{title}</Text>
    </Box>
  );
}
