import React from 'react';
import { Box, Text } from 'ink';
import type { Branch, Commit, Tag } from '../../../domain/tracker/types';
import type { Task, Project } from '../../../types/board';
import type { BacklogViewModel } from '../data/backlog-adapter';
import { getListViewportHeight } from '../layout';
import type { View } from '../types';
import { BoardView } from '../board';
import { TaskCockpit } from '../task-cockpit';
import { BacklogListView } from './BacklogListView';
import { DetailScreen } from './DetailScreen';
import { ProjectListView } from './ProjectListView';

type DashboardItem = Task | BacklogViewModel | Project;

interface BodyProps {
  view: View;
  detail: boolean;
  search: boolean;
  searchQuery: string;
  tasks: Task[];
  backlogs: BacklogViewModel[];
  projects: Project[];
  selectedIndex: number;
  scrollOffset: number;
  height: number;
  width: number;
  projectBranches: Branch[];
  projectTags: Tag[];
  projectCommits: Commit[];
  projectHasMore: boolean;
}

/** The content region expands into the row occupied by the search prompt only while searching. */
export function getBodyViewportHeight(height: number, search: boolean): number {
  return getListViewportHeight(height, { header: 1, context: search ? 1 : 0, footer: 1, spacer: 1 });
}

/**
 * The dashboard's middle region: an optional search prompt and exactly one
 * subview. Header and footer stay independent so chrome never competes with
 * the active view for space.
 */
export function Body({
  view,
  detail,
  search,
  searchQuery,
  tasks,
  backlogs,
  projects,
  selectedIndex,
  scrollOffset,
  height,
  width,
  projectBranches,
  projectTags,
  projectCommits,
  projectHasMore,
}: BodyProps) {
  const items: DashboardItem[] = view === 'tasks'
    ? tasks
    : view === 'projects'
      ? projects
      : backlogs;
  const viewportHeight = getBodyViewportHeight(height, search);
  const contentWidth = Math.max(1, width - 4);
  const selectedItem = items[selectedIndex];

  return (
    <>
      {search && (
        <Box height={1} flexShrink={0} overflow="hidden" paddingX={2}>
          <Text color="cyan" wrap="truncate">filter · /{searchQuery}_ · {items.length} matches</Text>
        </Box>
      )}
      <Box position="relative" height={viewportHeight} flexGrow={0} flexShrink={0} overflow="hidden" flexDirection="column" paddingX={2}>
        {detail && <DetailScreen
          item={selectedItem}
          view={view}
          height={viewportHeight}
          width={contentWidth}
          branches={projectBranches}
          tags={projectTags}
          commits={projectCommits}
        />}
        {!detail && view === 'tasks' && <TaskCockpit tasks={tasks} selectedIndex={selectedIndex} viewportHeight={viewportHeight} width={contentWidth} terminalWidth={width} />}
        {!detail && view === 'backlogs' && <BacklogListView backlogs={backlogs} selected={selectedIndex} scrollOffset={scrollOffset} viewportHeight={viewportHeight} width={contentWidth} />}
        {!detail && view === 'projects' && <ProjectListView projects={projects} selected={selectedIndex} scrollOffset={scrollOffset} viewportHeight={viewportHeight} width={contentWidth} />}
        {!detail && view === 'board' && <BoardView backlogs={backlogs} selectedIndex={selectedIndex} scrollOffset={scrollOffset} viewportHeight={viewportHeight} width={contentWidth} />}
        {!detail && view === 'projects' && projectHasMore && <Box position="absolute" right={2} bottom={0}><Text dimColor>↓ more available</Text></Box>}
      </Box>
    </>
  );
}
