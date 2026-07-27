import React from 'react';
import { Box, Text } from 'ink';
import { Task } from '../../../types/dashboard';
import { ListView } from './ListView';
import { formatRelativeTime } from '../../../lib/dashboard/utils';

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
            width="100%"
            overflow="hidden"
            flexDirection="row"
            borderStyle={isSelected ? 'round' : undefined}
            borderColor={isSelected ? 'white' : undefined}
            paddingX={1}
          >
            <Text color="white">{bullet} </Text>
            <Text color={color} bold> #{task.iid} </Text>
            <Text color={color}>{task.title || task.branch}</Text>
            <Text dimColor>  ─ {task.session || '–'} · {task.progress || '0%'} · {task.startedAt ? formatRelativeTime(task.startedAt) : '–'}</Text>
          </Box>
        );
      }}
    />
  );
}
