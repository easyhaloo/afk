import React from 'react';
import { Box, Text } from 'ink';
import type { Task, Project } from '../../../types/board';
import type { Branch, Commit, Tag } from '../../../domain/tracker/types';
import type { BacklogViewModel } from '../data/backlog-adapter';
import { parseMarkdownLine } from '../utils';
import { getExecutionModeColor, getExecutionModeIcon, getStatusColor, getStatusIcon } from './display';

interface Props {
  item: Task | BacklogViewModel | Project | undefined;
  view: string;
  height: number;
  width: number;
  branches?: Branch[];
  tags?: Tag[];
  commits?: Commit[];
}

export function DetailScreen({ item, view, height, width, branches = [], tags = [], commits = [] }: Props) {
  if (!item) {
    return (
      <Box flexDirection="column" height={height}>
        <Box height={1} paddingX={1}><Text bold color="white">detail</Text></Box>
        <Box flexGrow={1} paddingX={2}><Text color="gray">no item selected</Text></Box>
      </Box>
    );
  }

  const title = view === 'tasks'
    ? `task #${(item as Task).iid} · ${(item as Task).title}`
    : view === 'projects'
      ? `project · ${(item as Project).name}`
      : `${view === 'board' ? 'board' : 'backlog'} · ${(item as BacklogViewModel).title}`;

  return (
    <Box flexDirection="column" height={height} width={width}>
      <Box height={1} flexShrink={0} paddingX={1} backgroundColor="black">
        <Text bold color="white">▸ {title}</Text>
      </Box>
      <Box flexGrow={1} flexShrink={1} flexDirection="column" paddingX={2} paddingY={1}>
        {view === 'tasks' && <TaskDetail item={item as Task} />}
        {(view === 'backlogs' || view === 'board') && <BacklogDetail item={item as BacklogViewModel} />}
        {view === 'projects' && <ProjectDetail item={item as Project} branches={branches} tags={tags} commits={commits} />}
      </Box>
    </Box>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color="cyan" bold>{title}</Text>
      {children}
    </Box>
  );
}

function Field({ name, value, color = 'white' }: { name: string; value: string | number | undefined; color?: string }) {
  const displayValue = value === undefined || value === '' ? '–' : String(value);
  return <Text color={color}>{`  ${name} · ${displayValue}`}</Text>;
}

function StatusField({ name, status }: { name: string; status: string }) {
  return <Field name={name} value={getStatusIcon(status)} color={getStatusColor(status)} />;
}

function ExecutionModeField({ name, mode }: { name: string; mode: string }) {
  return <Field name={name} value={getExecutionModeIcon(mode) ?? '•'} color={getExecutionModeColor(mode)} />;
}

function TaskDetail({ item }: { item: Task }) {
  return (
    <Group title="runtime">
      <Field name="run" value={item.runId} />
      <Field name="phase" value={item.phase} />
      <StatusField name="status" status={item.status} />
      <ExecutionModeField name="execution mode" mode={item.executionMode} />
      <Field name="sandbox" value={item.sandboxProvider} />
      <Field name="agent" value={item.agentProvider} />
      <Field name="session" value={item.session} />
      <Field name="worktree" value={item.worktree} />
      <Field name="branch" value={item.branch} />
      <Field name="progress" value={item.progress} />
      <Field name="diagnostics" value={item.diagnosticPath} />
      <Field name="error" value={item.errorSummary} color="yellow" />
    </Group>
  );
}

function BacklogDetail({ item }: { item: BacklogViewModel }) {
  return (
    <>
      <Group title="identity">
        <Field name="title" value={item.title} />
        <StatusField name="state" status={item.state} />
        <ExecutionModeField name="executionMode" mode={item.executionMode} />
      </Group>
      <Group title="relationships">
        <Field name="parent" value={item.parentId} />
        <Field name="dependsOn" value={item.dependsOn.join(', ')} />
        <Field name="branch" value={item.branchName} />
        <Field name="providerRef" value={item.providerRef} />
      </Group>
      <Group title="metadata">
        <Field name="tags" value={item.tags.join(', ')} />
      </Group>
      <Description text={item.description} />
      {item.webUrl && <Field name="provider URL" value={item.webUrl} color="cyan" />}
    </>
  );
}

function ProjectDetail({ item, branches, tags, commits }: { item: Project; branches: Branch[]; tags: Tag[]; commits: Commit[] }) {
  return (
    <>
      <Group title="project">
        <Field name="namespace" value={item.namespace?.name} />
        <Field name="path" value={item.path_with_namespace} />
        {item.web_url && <Field name="provider URL" value={item.web_url} color="cyan" />}
      </Group>
      <Group title="repository">
        <Field name="commits" value={commits.length} />
        {commits.slice(0, 5).map((commit, index) => <Text key={`commit-${index}`} color="gray">    {commit.id}</Text>)}
        <Field name="branches" value={branches.length} />
        {branches.slice(0, 5).map((branch, index) => <Text key={`branch-${index}`} color="gray">    {branch.name}</Text>)}
        <Field name="tags" value={tags.length} />
        {tags.slice(0, 5).map((tag, index) => <Text key={`tag-${index}`} color="gray">    {tag.name}</Text>)}
      </Group>
      <Description text={item.description} />
    </>
  );
}

function Description({ text }: { text?: string }) {
  const lines = (text || 'no description').split('\n');
  return (
    <Group title="description">
      {lines.map((line, index) => {
        const parsed = parseMarkdownLine(line);
        return parsed
          ? <Text key={index} color="gray">{parsed}</Text>
          : <Text key={index} color="gray">{line || ' '}</Text>;
      })}
    </Group>
  );
}
