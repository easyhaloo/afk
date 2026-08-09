import React from 'react';
import { Box, Text } from 'ink';
import type { Task, TaskActivity } from '../../../types/board';
import { formatRelativeTime, truncateByVisualWidth } from '../utils';
import { getExecutionModeColor, getExecutionModeIcon, getStatusColor, getStatusIcon } from '../views/display';
import { getActivityLimit, getTaskPhaseLabel, getTaskProgress, getTaskQueue, truncateTaskText } from './model';

interface Props {
  tasks: Task[];
  selectedIndex: number;
  viewportHeight: number;
  width: number;
  terminalWidth?: number;
}

const phaseSteps = ['claimed', 'processing', 'verification', 'handoff'] as const;

export function TaskCockpit({ tasks, selectedIndex, viewportHeight, width, terminalWidth = width }: Props) {
  const focused = tasks[selectedIndex] ?? tasks[0];
  if (!focused) {
    return (
      <Box flexDirection="column" width={width} height={viewportHeight} justifyContent="center" alignItems="center" overflow="hidden">
        <Text color="gray">no running tasks · r refresh · 2 backlogs</Text>
      </Box>
    );
  }

  const queue = getTaskQueue(tasks, focused.runId);
  const compact = terminalWidth < 80;
  const showQueue = !compact && queue.length > 0;
  const queueWidth = terminalWidth >= 120 ? 28 : 24;
  const mainWidth = showQueue ? Math.max(1, width - queueWidth) : width;
  const activities = focused.activities ?? [];
  const activityLimit = getActivityLimit(terminalWidth);
  const visibleActivities = Number.isFinite(activityLimit) ? activities.slice(-activityLimit) : activities;
  const progress = getTaskProgress(focused);
  const phase = getTaskPhaseLabel(focused);
  const status = focused.errorSummary ? 'error' : focused.status === 'stale' ? 'stale' : 'active';
  const statusColor = getStatusColor(status);
  const modeIcon = getExecutionModeIcon(focused.executionMode);
  const runtimeContext = [
    focused.executionMode
      ? { text: `${modeIcon ? `${modeIcon} ` : ''}${focused.executionMode}`, color: getExecutionModeColor(focused.executionMode) }
      : undefined,
    focused.agentProvider ? { text: focused.agentProvider } : undefined,
    focused.sandboxProvider ? { text: focused.sandboxProvider } : undefined,
  ].filter((item): item is { text: string; color?: string } => item !== undefined);
  const locationContext = [
    focused.branch ? `branch ${focused.branch}` : undefined,
    focused.worktree ? `worktree ${focused.worktree}` : undefined,
    focused.session ? `session ${focused.session}` : undefined,
  ].filter((item): item is string => item !== undefined);
  const errorRows = focused.errorSummary ? 1 : 0;
  const queueSummaryRows = compact && queue.length > 0 ? 1 : 0;
  const identityRows = 2 + (runtimeContext.length > 0 ? 1 : 0) + (locationContext.length > 0 ? 1 : 0);
  const activityHeight = Math.max(1, viewportHeight - identityRows - 2 - 1 - errorRows - queueSummaryRows);

  return (
    <Box flexDirection="row" width={width} height={viewportHeight} overflow="hidden">
      <Box flexDirection="column" width={mainWidth} height={viewportHeight} overflow="hidden" paddingRight={showQueue ? 2 : 0}>
        <Box height={1} flexShrink={0} overflow="hidden">
          <Text wrap="truncate" color={statusColor} bold>{getStatusIcon(status)} {status} · {phase}</Text>
        </Box>
        <Box height={1} flexShrink={0} overflow="hidden">
          <Text wrap="truncate" bold color="white">#{focused.iid} {truncateTaskText(focused.title, Math.max(1, mainWidth - 4))}</Text>
        </Box>
        {runtimeContext.length > 0 && (
          <Box height={1} flexShrink={0} overflow="hidden">
            <Text wrap="truncate" dimColor>
              {runtimeContext.map((item, index) => (
                <React.Fragment key={item.text}>
                  {index > 0 && ' · '}
                  <Text color={item.color}>{item.text}</Text>
                </React.Fragment>
              ))}
            </Text>
          </Box>
        )}
        {locationContext.length > 0 && (
          <Box height={1} flexShrink={0} overflow="hidden">
            <Text wrap="truncate" dimColor>{locationContext.join(' · ')}</Text>
          </Box>
        )}
        {queueSummaryRows > 0 && <Box height={1} flexShrink={0} overflow="hidden"><Text dimColor>+{queue.length} queued</Text></Box>}
        <ProgressBar width={mainWidth} progress={progress} task={focused} />
        <PhaseRail phase={phase} width={mainWidth} />
        {focused.errorSummary && <Box height={1} flexShrink={0} overflow="hidden"><Text color="red" wrap="truncate">! error · {focused.errorSummary}</Text></Box>}
        <ActivityStream activities={visibleActivities} width={mainWidth} height={activityHeight} />
      </Box>
      {showQueue && (
        <TaskQueue tasks={queue} width={queueWidth} height={viewportHeight} />
      )}
    </Box>
  );
}

function ProgressBar({ width, progress, task }: { width: number; progress: number; task: Task }) {
  const barWidth = Math.max(1, Math.min(40, width - 20));
  const filled = Math.round(barWidth * progress / 100);
  const elapsed = task.startedAt ? formatRelativeTime(task.startedAt) : '–';
  return (
    <Box flexDirection="column" height={2} flexShrink={0} overflow="hidden">
      <Text color="gray">{`━`.repeat(filled)}<Text dimColor>{`─`.repeat(Math.max(0, barWidth - filled))}</Text></Text>
      <Text dimColor wrap="truncate">{getTaskPhaseLabel(task)} · {progress}% · {elapsed}</Text>
    </Box>
  );
}

function PhaseRail({ phase, width }: { phase: string; width: number }) {
  const segmentWidth = Math.max(1, Math.floor(Math.max(1, width - 3) / phaseSteps.length));
  const currentIndex = phase === 'verification' ? 2 : 1;
  return (
    <Box height={1} flexShrink={0} overflow="hidden">
      {phaseSteps.map((step, index) => {
        const isDone = index < currentIndex;
        const isCurrent = index === currentIndex;
        return (
          <Text key={step} color={isCurrent ? 'yellow' : isDone ? 'cyan' : 'gray'} bold={isCurrent} wrap="truncate">
            {(isDone ? '✓ ' : isCurrent ? '▶ ' : '· ')}{step.padEnd(Math.max(1, segmentWidth - 2), ' ')}
          </Text>
        );
      })}
    </Box>
  );
}

function ActivityStream({ activities, width, height }: { activities: TaskActivity[]; width: number; height: number }) {
  const visibleHeight = Math.max(1, height - 1);
  return (
    <Box flexDirection="column" height={height} flexShrink={0} overflow="hidden" borderTop borderColor="gray">
      <Text color="gray" dimColor>recent activity</Text>
      {activities.length === 0
        ? <Text color="gray" dimColor>waiting for runtime events</Text>
        : activities.slice(-visibleHeight).map(activity => <ActivityRow key={activity.id} activity={activity} width={width} />)}
    </Box>
  );
}

function ActivityRow({ activity, width }: { activity: TaskActivity; width: number }) {
  const time = Number.isFinite(activity.at.getTime()) ? activity.at.toISOString().slice(11, 16) : '--:--';
  const prefix = `${time} ${activity.kind} `;
  const message = truncateByVisualWidth(activity.message, Math.max(1, width - prefix.length - 3));
  return <Text wrap="truncate"><Text dimColor>{time} </Text><Text color={activity.kind === 'error' ? 'red' : activity.kind === 'test' ? 'green' : 'cyan'}>{activity.kind.padEnd(5, ' ')}</Text><Text> {message}</Text></Text>;
}

function TaskQueue({ tasks, width, height }: { tasks: Task[]; width: number; height: number }) {
  return (
    <Box flexDirection="column" width={width} height={height} overflow="hidden" borderLeft borderColor="gray" paddingLeft={1}>
      <Text color="gray" dimColor>queue {tasks.length}</Text>
      {tasks.length === 0
        ? <Text color="gray" dimColor>no other tasks</Text>
        : tasks.map(task => (
          <Box key={task.runId} flexDirection="column" height={2} overflow="hidden">
            <Text wrap="truncate" color={task.status === 'stale' ? 'red' : 'white'}>{getStatusIcon(task.status === 'stale' ? 'stale' : 'active')} #{task.iid}</Text>
            <Text wrap="truncate" dimColor>{truncateByVisualWidth(task.title, Math.max(1, width - 3))}</Text>
          </Box>
        ))}
    </Box>
  );
}
