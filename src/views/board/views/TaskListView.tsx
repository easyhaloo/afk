import React from 'react';
import { Box, Text } from 'ink';
import { Task } from '../../../types/board';
import { ListView } from './ListView';
import { formatRelativeTime } from '../utils';

interface Props {
  tasks: Task[];
  selected: number;
  scrollOffset: number;
  viewportHeight: number;
}

function WorktreePath({ path }: { path?: string }) {
  if (!path) return null;
  const short = path.replace(process.env.HOME || '', '~');
  return (
    <Text dimColor> · wt:{short}</Text>
  );
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
            paddingX={1}
          >
            <Text color={isSelected ? 'white' : color}>{bullet} </Text>
            <Text color={isSelected ? 'white' : color} bold> #{task.iid} </Text>
            <Text color={isSelected ? 'white' : color}>{task.title || task.branch}</Text>
            <Text dimColor> · {task.session || '–'}</Text>
            <WorktreePath path={task.worktree} />
            <Text dimColor> · {task.progress || '0%'}</Text>
            <Text dimColor> · {task.startedAt ? formatRelativeTime(task.startedAt) : '–'}</Text>
          </Box>
        );
      }}
    />
  );
}
