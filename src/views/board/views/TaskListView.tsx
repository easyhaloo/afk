import React from 'react';
import { Task } from '../../../types/board';
import { ListView, normalizeRowText } from './ListView';
import { formatRelativeTime } from '../utils';
import { OperationalRow } from './OperationalRow';
import { getStatusColor } from './display';

interface Props {
  tasks: Task[];
  selected: number;
  scrollOffset: number;
  viewportHeight: number;
  width?: number;
}

export function TaskListView({ tasks, selected, scrollOffset, viewportHeight, width: requestedWidth }: Props) {
  const width = requestedWidth || process.stdout.columns || 80;
  return (
    <ListView
      items={tasks}
      selected={selected}
      scrollOffset={scrollOffset}
      viewportHeight={viewportHeight}
      width={width}
      emptyMessage="ℹ  no running tasks"
      getKey={(task) => task.runId}
      render={(task, _index, isSelected) => {
        const worktree = task.worktree
          ? normalizeRowText(task.worktree.replace(process.env.HOME || '', '~'))
          : '–';
        const summary = [
          `phase ${task.phase}`,
          `${task.executionMode}/${task.sandboxProvider}`,
          `session ${normalizeRowText(task.session || '') || '–'}`,
          `branch ${normalizeRowText(task.branch || '') || '–'}`,
          `worktree ${worktree}`,
          `progress ${normalizeRowText(task.progress || '') || '0%'}`,
          task.startedAt ? formatRelativeTime(task.startedAt) : '–',
        ].join(' · ');
        return (
          <OperationalRow
            width={width}
            selected={isSelected}
            status={task.status}
            statusColor={isSelected ? 'white' : getStatusColor(task.status)}
            mode={task.executionMode}
            id={task.iid}
            title={normalizeRowText(task.title || task.branch || '') || 'untitled task'}
            summary={summary}
          />
        );
      }}
    />
  );
}
