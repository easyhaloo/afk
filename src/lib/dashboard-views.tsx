/**
 * AFK Dashboard - View Components
 * List views, detail screen, help dialog, and UI helpers
 */

import React from 'react';
import { Box, Text } from 'ink';
import { Task, Issue, Project } from '../types/dashboard';

/* ============ List View Components ============ */

type ListViewProps<T> = {
  items: T[];
  selected: number;
  scrollOffset: number;
  viewportHeight: number;
  renderItem: (item: T, index: number, isSelected: boolean) => React.ReactNode;
  emptyMessage: string;
};

function ListView<T>({ items, selected, scrollOffset, viewportHeight, renderItem, emptyMessage }: ListViewProps<T>) {
  if (items.length === 0) {
    return (
      <Box justifyContent="center" alignItems="center" height="100%">
        <Text color="gray">  {emptyMessage}</Text>
      </Box>
    );
  }
  const visible = items.slice(scrollOffset, scrollOffset + viewportHeight);
  return (
    <>
      {visible.map((item, visibleIndex) => {
        const index = scrollOffset + visibleIndex;
        return (
          <React.Fragment key={typeof item === 'object' && item !== null && 'id' in item ? (item as any).id : typeof item === 'object' && item !== null && 'iid' in item ? (item as any).iid : index}>
            {renderItem(item, index, index === selected)}
          </React.Fragment>
        );
      })}
    </>
  );
}

const TaskListView: React.FC<{tasks: Task[]; selected: number; scrollOffset: number; viewportHeight: number}> = ({ tasks, selected, scrollOffset, viewportHeight }) => {
  return (
    <ListView
      items={tasks}
      selected={selected}
      scrollOffset={scrollOffset}
      viewportHeight={viewportHeight}
      emptyMessage="ℹ  no running tasks"
      renderItem={(task, index, isSelected) => {
        const textColor = isSelected ? 'white' : 'gray';
        const bullet = isSelected ? '(*)' : (task.status === 'active' ? '(.)' : '(-)');
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
              <Text color={textColor} bold> #{task.iid} </Text>
              <Text color={textColor}>{task.title || task.branch}</Text>
            </Box>
            <Box paddingLeft={2}>
              <Text dimColor>  ─ {task.session || '–'} │ {task.progress || '0%'} │ {task.startedAt ? formatTime(task.startedAt) : '–'}</Text>
            </Box>
          </Box>
        );
      }}
    />
  );
};

const IssueListView: React.FC<{issues: Issue[]; selected: number; multiSelectMode?: boolean; selectedIssues?: Set<number>; scrollOffset: number; viewportHeight: number}> = ({ issues, selected, multiSelectMode = false, selectedIssues = new Set(), scrollOffset, viewportHeight }) => {
  return (
    <ListView
      items={issues}
      selected={selected}
      scrollOffset={scrollOffset}
      viewportHeight={viewportHeight}
      emptyMessage="ℹ  no issues"
      renderItem={(issue, index, isCurrent) => {
        const isSelected = selectedIssues.has(issue.iid);
        const checkbox = multiSelectMode ? (isSelected ? '☒' : '☐') : '○';
        const textColor = isCurrent ? 'white' : 'gray';
        return (
          <Box
            key={issue.iid}
            minHeight={4}
            overflow="hidden"
            flexDirection="column"
            borderStyle={isCurrent ? 'round' : undefined}
            borderColor={isCurrent ? 'white' : undefined}
            paddingX={1}
            backgroundColor={isSelected ? 'gray' : undefined}
          >
            <Box>
              <Text color={textColor}>{checkbox} </Text>
              <Text color={textColor} bold> #{issue.iid} </Text>
              <Text color={textColor}>{issue.title}</Text>
            </Box>
            <Box paddingLeft={2}>
              <Text dimColor>  ─ {issue.labels.length > 0 ? issue.labels.join(', ') : '–'}</Text>
              <Text dimColor> · {issue.description ? truncate(issue.description, 40) : '…'}</Text>
            </Box>
          </Box>
        );
      }}
    />
  );
};

const CompletedListView: React.FC<{tasks: Task[]; selected: number; scrollOffset: number; viewportHeight: number}> = ({ tasks, selected, scrollOffset, viewportHeight }) => {
  return (
    <ListView
      items={tasks}
      selected={selected}
      scrollOffset={scrollOffset}
      viewportHeight={viewportHeight}
      emptyMessage="ℹ  no completed tasks"
      renderItem={(task, index, isSelected) => {
        const textColor = isSelected ? 'white' : 'gray';
        return (
          <Box
            key={task.iid}
            minHeight={3}
            overflow="hidden"
            flexDirection="column"
            borderStyle={isSelected ? 'round' : undefined}
            borderColor={isSelected ? 'white' : undefined}
            paddingX={1}
          >
            <Box>
              <Text color="white">✔ </Text>
              <Text color={textColor} bold> #{task.iid} </Text>
              <Text color={textColor}>{task.title || task.branch}</Text>
              <Text dimColor>  ─ 100% · {task.startedAt ? formatTime(task.startedAt) : '–'}</Text>
            </Box>
          </Box>
        );
      }}
    />
  );
};

const ProjectListView: React.FC<{projects: Project[]; selected: number; scrollOffset: number; viewportHeight: number}> = ({ projects, selected, scrollOffset, viewportHeight }) => {
  return (
    <ListView
      items={projects}
      selected={selected}
      scrollOffset={scrollOffset}
      viewportHeight={viewportHeight}
      emptyMessage="ℹ  no projects"
      renderItem={(project, index, isSelected) => {
        const textColor = isSelected ? 'white' : 'gray';
        return (
          <Box
            key={project.id}
            minHeight={3}
            overflow="hidden"
            flexDirection="column"
            borderStyle={isSelected ? 'round' : undefined}
            borderColor={isSelected ? 'white' : undefined}
            paddingX={1}
          >
            <Box>
              <Text color={textColor}>{isSelected ? '◉' : '▸'} </Text>
              <Text color={textColor} bold> #{project.id} </Text>
              <Text color={textColor}>{project.name}</Text>
            </Box>
            <Box paddingLeft={2}>
              <Text dimColor>  ─ {project.description ? truncate(project.description, 50) : '…'}</Text>
            </Box>
          </Box>
        );
      }}
    />
  );
};

/* ============ Detail & Help Components ============ */

const DetailScreen: React.FC<{
  item: Task | Issue | Project | undefined;
  view: 'tasks' | 'issues' | 'completed' | 'projects';
  height: number;
  branches?: any[];
  tags?: any[];
  commits?: any[];
}> = ({ item, view, height, branches = [], tags = [], commits = [] }) => {
  if (!item) return <Box><Text color="gray">ℹ  no item selected</Text></Box>;

  const HEADER_HEIGHT = 1;
  const FOOTER_HEIGHT = 1;
  const CONTENT_HEIGHT = height - HEADER_HEIGHT - FOOTER_HEIGHT;

  const getTitle = () => {
    if (view === 'issues') return `issue #${(item as Issue).iid}`;
    if (view === 'projects') return `project #${(item as Project).id}`;
    return `task #${(item as Task).iid}`;
  };

  const getSubtitle = () => {
    if (view === 'projects') return (item as Project).name;
    return (item as any).title || (item as Task).branch;
  };

  const fmtDate = (d: string | undefined) => {
    if (!d) return '–';
    const date = new Date(d);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMin = Math.floor(diffMs / 60000);
    const diffH = Math.floor(diffMin / 60);
    const diffD = Math.floor(diffH / 24);
    if (diffMin < 1) return 'just now';
    if (diffMin < 60) return `${diffMin}m`;
    if (diffH < 24) return `${diffH}h`;
    if (diffD < 30) return `${diffD}d`;
    return date.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
  };

  return (
    <Box flexDirection="column" height={height}>
      <Box height={HEADER_HEIGHT} flexShrink={0} paddingX={1} backgroundColor="black" justifyContent="center">
        <Text color="white">
          <Text bold>▸ </Text>
          <Text>{getTitle()}</Text>
          <Text color="gray"> │ </Text>
          <Text>{getSubtitle()}</Text>
        </Text>
      </Box>

      <Box height={CONTENT_HEIGHT} flexShrink={0} flexDirection="column" paddingX={2} paddingY={1}>
        <Text color="gray">┌────────────────────────────────────────────┐</Text>

        {view === 'tasks' && (
          <Box flexDirection="column" paddingX={1}>
            <Text color="white">  ─ status: {(item as Task).status}</Text>
            <Text color="white">  ─ branch: {(item as Task).branch || '–'}</Text>
            <Text color="white">  ─ session: {(item as Task).session || '–'}</Text>
            <Text color="white">  ─ progress: {(item as Task).progress || '0%'}</Text>
            <Text color="white">  ─ started: {(item as Task).startedAt ? (item as Task).startedAt?.toString() : '–'}</Text>
            <Text color="white">  ─ worktree: {(item as Task).worktree || '–'}</Text>
          </Box>
        )}

        {view === 'issues' && (
          <Box flexDirection="column" paddingX={1}>
            <Text color="white">  ─ labels: {(item as Issue).labels.join(', ') || '–'}</Text>
            <Text color="white">  ─ state: {(item as Issue).state}</Text>
            <Text color="white">  ─ url: {(item as Issue).web_url}</Text>
            <Box marginTop={1}>
              <Text color="gray">  ─ description:</Text>
            </Box>
            <Text color="gray">    {(item as Issue).description || 'no description'}</Text>
          </Box>
        )}

        {view === 'projects' && (
          <Box flexDirection="column" paddingX={1}>
            <Text color="white">  ─ path: {(item as Project).path_with_namespace}</Text>
            <Text color="white">  ─ branch: {(item as Project).default_branch}</Text>
            <Text color="white">  ─ namespace: {(item as Project).namespace.name}</Text>
            <Text color="white">  ─ updated: {fmtDate((item as Project).last_activity_at)}</Text>
            <Text color="white">  ─ branches: {branches.length}</Text>
            <Text color="white">  ─ tags: {tags.length}</Text>
            <Text color="white">  ─ recent commits: {commits.length}</Text>
            <Box marginTop={1}>
              <Text color="gray">  ─ description:</Text>
            </Box>
            <Text color="gray">    {(item as Project).description || 'no description'}</Text>
          </Box>
        )}

        <Text color="gray">└────────────────────────────────────────────┘</Text>
      </Box>

      <Box height={FOOTER_HEIGHT} flexShrink={0} paddingX={1} backgroundColor="black" justifyContent="center">
        <Text color="gray">ESC │ ℹ  ( o_o )</Text>
      </Box>
    </Box>
  );
};

const HelpDialog: React.FC = () => {
  return (
    <Box
      position="absolute"
      top={3}
      left={8}
      right={8}
      bottom={3}
      borderStyle="round"
      borderColor="white"
      backgroundColor="black"
      flexDirection="column"
      padding={1}
    >
      <Box marginBottom={1}>
        <Text bold color="white">▸ Help ▸</Text>
      </Box>

      <Text color="gray">view switch:</Text>
      <Text color="white">  1 - tasks     2 - issues</Text>
      <Text color="white">  3 - done     4 - projects</Text>

      <Box marginTop={1}>
        <Text color="gray">navigate:</Text>
      </Box>
      <Text color="white">  ↑↓ - move</Text>
      <Text color="white">  g/G - top/bottom</Text>

      <Box marginTop={1}>
        <Text color="gray">actions:</Text>
      </Box>
      <Text color="white">  ↵ - detail</Text>
      <Text color="white">  r - refresh</Text>
      <Text color="white">  q - quit</Text>

      <Box marginTop={1}>
        <Text color="gray">tasks:</Text>
      </Box>
      <Text color="white">  a - attach   K - kill</Text>

      <Box marginTop={1}>
        <Text color="gray">issues:</Text>
      </Box>
      <Text color="white">  s - start    o - open</Text>
      <Text color="white">  m - multi select</Text>

      <Box marginTop={1}>
        <Text color="gray">projects:</Text>
      </Box>
      <Text color="white">  ↵ - detail   o - open</Text>

      <Box marginTop={1} justifyContent="center">
        <Text color="gray">? or ESC to close ( o_o )</Text>
      </Box>
    </Box>
  );
};

/* ============ Breathing Separator ============ */

const BreathingSeparator: React.FC<{ width: number; breathPhase: number; isTop?: boolean }> = ({ width, breathPhase, isTop = true }) => {
  const breathIntensity = (Math.sin(breathPhase * Math.PI / 50) + 1) / 2;
  const grayValue = Math.round(128 - breathIntensity * 100);

  const generateWavePattern = (w: number): string => {
    let pattern = '';
    for (let i = 0; i < w - 2; i++) {
      const waveType = i % 10;
      if (waveType < 4) {
        pattern += '~';
      } else if (waveType < 6) {
        pattern += '~~';
        i++;
      } else if (waveType < 8) {
        pattern += '~~~';
        i += 2;
      } else {
        pattern += '-';
      }
    }
    return pattern.substring(0, w - 2);
  };

  const pattern = generateWavePattern(width);
  const startChar = isTop ? '.' : '`';
  const endChar = isTop ? '.' : "'";

  return (
    <Text color={`${grayValue}`}>
      {startChar}{pattern}{endChar}
    </Text>
  );
};

/* ============ Helpers ============ */

function formatTime(date: Date): string {
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  const hours = Math.floor(diff / 3600000);

  if (hours < 1) return '<1h';
  if (hours < 24) return `${hours}h`;

  const days = Math.floor(hours / 24);
  return `${days}d`;
}

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.substring(0, maxLength - 3) + '…';
}

export {
  TaskListView,
  IssueListView,
  CompletedListView,
  ProjectListView,
  DetailScreen,
  HelpDialog,
  BreathingSeparator,
  formatTime,
  truncate,
};
