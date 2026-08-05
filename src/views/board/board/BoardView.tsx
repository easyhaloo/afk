import React from 'react';
import { Box, Text } from 'ink';
import type { BacklogViewModel } from '../data/backlog-adapter';
import { BacklogRow } from '../views/BacklogRow';

interface BoardViewProps {
  backlogs: BacklogViewModel[];
  selectedIndex: number;
  scrollOffset: number;
  viewportHeight: number;
  width?: number;
}

/** List-only board using canonical backlog state and execution mode. */
export const BoardView: React.FC<BoardViewProps> = ({
  backlogs,
  selectedIndex,
  scrollOffset,
  viewportHeight,
  width: parentWidth,
}) => {
  const width = parentWidth || process.stdout.columns || 80;

  return (
    <Box flexDirection="column" width={width} flexGrow={1}>
      <Text bold color="cyan">board · {backlogs.length} backlogs</Text>
      <Text dimColor>{'─'.repeat(Math.min(Math.max(width - 2, 0), 50))}</Text>
      {backlogs.length === 0 && <Text dimColor italic>no backlogs</Text>}
      {backlogs.slice(scrollOffset, scrollOffset + viewportHeight).map((backlog, index) => {
        return (
          <BacklogRow
            key={backlog.id}
            backlog={backlog}
            selected={scrollOffset + index === selectedIndex}
            width={width}
          />
        );
      })}
    </Box>
  );
};
