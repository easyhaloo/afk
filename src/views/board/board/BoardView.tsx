import React from 'react';
import { Box, Text } from 'ink';
import type { BacklogViewModel } from '../data/backlog-adapter';
import { BoardLane } from './BoardLane';
import {
  getBoardColumns,
  getBoardColumnIcon,
  getBoardLayout,
  getBoardVisibleLaneIndexes,
  getFocusedColumnIndex,
  groupBacklogsByState,
} from './model';
import { getStatusColor } from '../views/display';

interface BoardViewProps {
  backlogs: BacklogViewModel[];
  selectedIndex: number;
  scrollOffset: number;
  viewportHeight: number;
  width?: number;
}

function PipelineStrip({ lanes, focusedColumn, width }: { lanes: ReturnType<typeof groupBacklogsByState>; focusedColumn: number; width: number }) {
  const columns = getBoardColumns(lanes);
  const compact = width < 100;
  return (
    <Box height={1} width={width} overflow="hidden">
      <Text color="white" wrap="truncate">
        <Text bold dimColor>flow</Text>
        <Text dimColor> </Text>
        {columns.map((column, index) => {
          const color = column.kind === 'attention'
            ? column.items.some(item => item.state === 'blocked') ? 'red' : 'yellow'
            : column.state ? getStatusColor(column.state) : 'white';
          const marker = index === focusedColumn ? '▸ ' : '';
          return (
            <React.Fragment key={column.key}>
              {index > 0 && <Text dimColor> │ </Text>}
              <Text color={color} bold={index === focusedColumn}>{marker}{getBoardColumnIcon(column)} {compact ? getCompactColumnLabel(column.key) : column.label} {column.items.length}</Text>
            </React.Fragment>
          );
        })}
      </Text>
    </Box>
  );
}

function getCompactColumnLabel(key: string): string {
  switch (key) {
    case 'in_progress': return 'Proc';
    case 'verification': return 'Verify';
    case 'merge_ready': return 'Merge';
    case 'attention': return 'Alert';
    default: return key === 'ready' ? 'Ready' : 'Done';
  }
}

/** Parallel kanban with a compact exception queue and done archive. */
export const BoardView: React.FC<BoardViewProps> = ({
  backlogs,
  selectedIndex,
  viewportHeight,
  width: parentWidth,
}) => {
  const width = parentWidth || process.stdout.columns || 80;
  const layout = getBoardLayout(width);
  const lanes = groupBacklogsByState(backlogs);
  const columns = getBoardColumns(lanes);
  const selected = backlogs[selectedIndex];
  const selectedId = selected?.id;
  const focusedColumn = getFocusedColumnIndex(columns, selectedId);
  const focused = columns[focusedColumn];
  const isAuxiliary = focused?.kind !== 'primary';
  const visibleColumnIndexes = isAuxiliary
    ? [focusedColumn]
    : getBoardVisibleLaneIndexes(focusedColumn, 4, layout.visibleLaneCount);
  const laneWidth = Math.max(1, Math.floor(width / visibleColumnIndexes.length));
  const bodyHeight = Math.max(1, viewportHeight - 1);

  if (backlogs.length === 0) {
    return (
      <Box flexDirection="column" width={width} height={viewportHeight} overflow="hidden" flexShrink={0}>
        <PipelineStrip lanes={lanes} focusedColumn={focusedColumn} width={width} />
        <Box height={bodyHeight} justifyContent="center" alignItems="center" overflow="hidden">
          <Text color="gray">no matching backlogs</Text>
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" width={width} height={viewportHeight} overflow="hidden" flexGrow={0} flexShrink={0}>
      <PipelineStrip lanes={lanes} focusedColumn={focusedColumn} width={width} />
      <Box flexDirection="row" height={bodyHeight} overflow="hidden">
        {visibleColumnIndexes.map(index => {
          const column = columns[index];
          const selectedIndexInColumn = selectedId ? column.items.findIndex(item => item.id === selectedId) : -1;
          return (
            <BoardLane
              key={column.key}
              label={column.label}
              kind={column.kind}
              state={column.state}
              items={column.items}
              focused={index === focusedColumn}
              selectedId={selectedId}
              selectedIndex={selectedIndexInColumn}
              width={laneWidth}
              height={bodyHeight}
            />
          );
        })}
      </Box>
    </Box>
  );
};
