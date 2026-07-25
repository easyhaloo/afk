import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import open from 'open';
import { Task, Issue, Project } from '../../../types/dashboard';
import type { View } from '../types';

interface Props {
  item: Task | Issue | Project | undefined;
  view: View;
  height: number;
  width: number;
  branches?: any[];
  tags?: any[];
  commits?: any[];
}

export function DetailScreen({ item, view, height, width, branches = [], tags = [], commits = [] }: Props) {
  const [hoverIdx, setHoverIdx] = useState(-1);

  if (!item) return <Box><Text color="gray">ℹ  no item selected</Text></Box>;

  const HDR = 1;
  const FTR = 1;
  const BODY = height - HDR - FTR;
  const MAX_W = 90;
  const W = Math.min(MAX_W, width - 4);

  const title = view === 'issues' ? `issue #${(item as Issue).iid}`
    : view === 'projects' ? `project #${(item as Project).id}`
    : `task #${(item as Task).iid}`;

  const subtitle = view === 'projects' ? (item as Project).name
    : (item as any).title || (item as Task).branch;

  const top = '┌' + '─'.repeat(W) + '┐';
  const bottom = '└' + '─'.repeat(W) + '┘';

  // Build clickable rows in visual order
  const clickableRows: { idx: number; url: string; label: string }[] = [];
  if (view === 'issues') {
    const url = (item as Issue).web_url;
    if (url) clickableRows.push({ idx: 0, url, label: 'url' });
  }
  if (view === 'projects') {
    const projUrl = (item as Project).web_url || '';
    clickableRows.push({ idx: 0, url: projUrl, label: 'project' });
    commits.slice(0, 5).forEach((c, i) => clickableRows.push({ idx: 2 + i, url: `${projUrl}/-/commit/${c.id}`, label: `commit ${c.id}` }));
    branches.slice(0, 4).forEach((b, i) => clickableRows.push({ idx: 8 + i, url: `${projUrl}/-/tree/${b.name}`, label: `branch ${b.name}` }));
    tags.slice(0, 4).forEach((t, i) => clickableRows.push({ idx: 13 + i, url: `${projUrl}/-/tags/${t.name}`, label: `tag ${t.name}` }));
  }

  // Keyboard navigation
  useInput((input, key) => {
    if (key.return && hoverIdx >= 0 && hoverIdx < clickableRows.length) {
      open(clickableRows[hoverIdx].url).catch(() => {});
    }
    if (key.downArrow || key.rightArrow) {
      setHoverIdx(i => Math.min(i + 1, clickableRows.length - 1));
    }
    if (key.upArrow || key.leftArrow) {
      setHoverIdx(i => Math.max(i - 1, 0));
    }
  });

  const isHovered = (idx: number) => hoverIdx >= 0 && clickableRows[hoverIdx]?.idx === idx;

  return (
    <Box flexDirection="column" height={height}>
      <Box height={HDR} flexShrink={0} paddingX={1} backgroundColor="black" justifyContent="center">
        <Text color="white"><Text bold>▸ </Text><Text>{title}</Text><Text color="gray"> │ </Text><Text>{subtitle}</Text></Text>
      </Box>

      <Box height={BODY} flexShrink={0} flexDirection="column" paddingX={2} paddingY={1}>
        <Text color="gray">{top}</Text>

        {view === 'tasks' && <TaskDetail item={item as Task} />}
        {view === 'issues' && <IssueDetail item={item as Issue} hovered={isHovered(0)} />}
        {view === 'projects' && (
          <ProjectDetail
            item={item as Project}
            branches={branches}
            tags={tags}
            commits={commits}
            innerW={W}
            isHovered={isHovered}
          />
        )}

        <Text color="gray">{bottom}</Text>
      </Box>

      <Box height={FTR} flexShrink={0} paddingX={1} backgroundColor="black" justifyContent="center">
        <Text color="gray">b │ q exit │ ↑↓ navigate │ ↵ open</Text>
      </Box>
    </Box>
  );
}

function TaskDetail({ item }: { item: Task }) {
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text color="white">  ─ status: {item.status}</Text>
      <Text color="white">  ─ branch: {item.branch || '–'}</Text>
      <Text color="white">  ─ session: {item.session || '–'}</Text>
      <Text color="white">  ─ progress: {item.progress || '0%'}</Text>
      <Text color="white">  ─ started: {item.startedAt ? item.startedAt.toString() : '–'}</Text>
      <Text color="white">  ─ worktree: {item.worktree || '–'}</Text>
    </Box>
  );
}

function IssueDetail({ item, hovered }: { item: Issue; hovered: boolean }) {
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text color={hovered ? 'cyan' : 'white'} underline={hovered}>  ─ url: {item.web_url}</Text>
      <Text color="white">  ─ labels: {item.labels.join(', ') || '–'}</Text>
      <Text color="white">  ─ state: {item.state}</Text>
      <Box marginTop={1}><Text color="gray">  ─ description:</Text></Box>
      <Text color="gray">    {item.description || 'no description'}</Text>
    </Box>
  );
}

function ProjectDetail({ item, branches, tags, commits, innerW, isHovered }: {
  item: Project; branches: any[]; tags: any[]; commits: any[]; innerW: number; isHovered: (r: number) => boolean;
}) {
  const fmtDate = (d: string | undefined) => {
    if (!d) return '–';
    const diff = Date.now() - new Date(d).getTime();
    const m = Math.floor(diff / 60000);
    const h = Math.floor(m / 60);
    const day = Math.floor(h / 24);
    if (m < 1) return 'just now';
    if (m < 60) return `${m}m`;
    if (h < 24) return `${h}h`;
    if (day < 30) return `${day}d`;
    return new Date(d).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
  };

  const maxCommitTitle = Math.max(20, innerW - 38);
  const maxBranchName = Math.max(20, innerW - 45);
  const maxDesc = innerW - 4;

  return (
    <Box flexDirection="column" paddingX={1} overflow="hidden">
      {/* Row 0: project path + url */}
      <Text color={isHovered(0) ? 'cyan' : 'white'} underline={isHovered(0)}>  {item.path_with_namespace}</Text>
      {item.description && <Text dimColor>  {truncate(item.description, maxDesc)}</Text>}

      {/* "recent" header */}
      <Box marginTop={1}>
        <Text color="white" bold>recent</Text>
      </Box>

      {/* Rows 2–6: commits */}
      {commits.length === 0 ? (
        <Text dimColor>  loading…</Text>
      ) : (
        commits.slice(0, 5).map((c, i) => {
          const row = 2 + i;
          return (
            <Box key={i} flexWrap="wrap">
              <Text color={isHovered(row) ? 'cyan' : 'white'} underline={isHovered(row)}>{'  '}{c.id}</Text>
              <Text color="gray"> · {truncate(c.author, 12)}</Text>
              <Text color="gray"> · {truncate(c.title, maxCommitTitle)}</Text>
              <Text dimColor> · {fmtDate(c.committed_date)}</Text>
            </Box>
          );
        })
      )}

      {/* "branches" header */}
      <Box marginTop={1}>
        <Text color="white" bold>branches</Text>
        <Text dimColor> ({branches.length})</Text>
      </Box>

      {/* Rows 8–11: branches */}
      {branches.length === 0 ? (
        <Text dimColor>  loading…</Text>
      ) : (
        branches.slice(0, 4).map((b, i) => {
          const row = 8 + i;
          return (
            <Box key={i} flexWrap="wrap">
              <Text color={isHovered(row) ? 'cyan' : (b.protected ? 'cyan' : 'gray')} underline={isHovered(row)}>
                {b.protected ? '  ★' : '  ○'} {truncate(b.name, maxBranchName)}
              </Text>
              <Text dimColor> · {truncate(b.commit, 8)}</Text>
              <Text dimColor> · {truncate(b.author || '—', 12)}</Text>
              <Text dimColor> · {fmtDate(b.committed_date)}</Text>
            </Box>
          );
        })
      )}

      {/* Tags */}
      {tags.length > 0 && (
        <>
          <Box marginTop={1}>
            <Text color="white" bold>tags</Text>
            <Text dimColor> ({tags.length})</Text>
          </Box>
          {tags.slice(0, 4).map((t, i) => {
            const row = 13 + i;
            const msg = t.message ? truncate(t.message, maxDesc - 6) : '';
            return (
              <Box key={i} flexDirection="column">
                <Box flexWrap="wrap">
                  <Text color={isHovered(row) ? 'cyan' : 'white'} underline={isHovered(row)}>  {t.name}</Text>
                  <Text dimColor> · {truncate(t.commit, 8)}</Text>
                  {t.commit_author ? <Text dimColor> · {truncate(t.commit_author, 12)}</Text> : null}
                  <Text dimColor> · {fmtDate(t.commit_date)}</Text>
                </Box>
                {msg ? <Text dimColor>      {msg}</Text> : null}
              </Box>
            );
          })}
        </>
      )}
    </Box>
  );
}

function truncate(text: string, max: number): string {
  if (!text) return '';
  if (text.length <= max) return text;
  return text.substring(0, max - 1) + '…';
}
