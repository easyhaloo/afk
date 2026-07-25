import React from 'react';
import { Box, Text } from 'ink';
import { Task } from '../../../types/dashboard';
import { ListView } from './ListView';

interface Props {
  tasks: Task[];
  selected: number;
  scrollOffset: number;
  viewportHeight: number;
}

export function TaskListView({ tasks, selected, scrollOffset, viewportHeight }: Props) {
  return (
    <ListView
      items={tasks}
      selected={selected}
      scrollOffset={scrollOffset}
      viewportHeight={viewportHeight}
      emptyMessage="ℹ  no running tasks"
      getKey={(task) => task.iid}
      render={(task, index, isSelected) => {
        const color = isSelected ? 'white' : 'gray';
        const bullet = isSelected ? '◉' : (task.status === 'active' ? '●' : '○');
        return (
          <Box
            key={task.iid}
            minHeight={4}
            overflow="hidden"
            flexDirection="column"
            borderStyle={isSelected ? 'round' : undefined}
            borderColor={isSelected ? 'white' : undefined}
            paddingX={1}
          >
            <Box>
              <Text color="white">{bullet} </Text>
              <Text color={color} bold> #{task.iid} </Text>
              <Text color={color}>{task.title || task.branch}</Text>
            </Box>
            <Box paddingLeft={2}>
              <Text dimColor>  ─ {task.session || '–'} · {task.progress || '0%'} · {task.startedAt ? formatTime(task.startedAt) : '–'}</Text>
            </Box>
          </Box>
        );
      }}
    />
  );
}

function formatTime(date: Date): string {
  const diff = Date.now() - date.getTime();
  const h = Math.floor(diff / 3600000);
  if (h < 1) return '<1h';
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}
