import React from 'react';
import { Box, Text } from 'ink';
import type { BacklogViewModel } from '../data/backlog-adapter';
import { backlogStateColor } from '../views/BacklogRow';
import { BoardCard } from './BoardCard';
import { getBoardColumnIcon } from './model';
import type { BoardColumnKind } from './model';

export interface BoardLaneProps {
  label: string;
  state?: BacklogViewModel['state'];
  kind: BoardColumnKind;
  items: BacklogViewModel[];
  width: number;
  height: number;
  focused: boolean;
  selectedId?: string;
  selectedIndex?: number;
}

export function BoardLane({ label, state, kind, items, width, height, focused, selectedId, selectedIndex = -1 }: BoardLaneProps) {
  const maxVisibleCards = Math.max(1, Math.floor(Math.max(0, height - 2) / 2));
  const start = selectedIndex < 0
    ? 0
    : Math.min(Math.max(0, selectedIndex - maxVisibleCards + 1), Math.max(0, items.length - maxVisibleCards));
  const visibleCards = items.slice(start, start + maxVisibleCards);
  const laneColor = kind === 'attention'
    ? (items.some(item => item.state === 'blocked') ? 'red' : 'yellow')
    : kind === 'done'
      ? 'green'
      : state
        ? backlogStateColor(state)
        : 'white';

  return (
    <Box flexDirection="column" width={width} height={height} overflow="hidden" flexShrink={0}>
      <Text color={focused ? laneColor : 'white'} bold wrap="truncate">
        <Text color={laneColor}>{getBoardColumnIcon({ kind, state, items })}</Text>
        <Text> {label} </Text>
        <Text color={laneColor}>{items.length}</Text>
        {focused && selectedIndex >= 0 && <Text dimColor> · {selectedIndex + 1}/{items.length}</Text>}
      </Text>
      <Text dimColor>{'─'.repeat(Math.max(0, Math.min(width - 1, 40)))}</Text>
      {visibleCards.length === 0 ? (
        <Text color="gray" dimColor>{kind === 'done' ? 'no finished backlogs' : kind === 'attention' ? 'no attention items' : 'no backlog'}</Text>
      ) : (
        visibleCards.map(backlog => (
          <BoardCard key={backlog.id} backlog={backlog} selected={backlog.id === selectedId} width={width} />
        ))
      )}
    </Box>
  );
}
