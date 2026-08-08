import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Box, useInput } from 'ink';
import { useState as useAppState, createActions } from './hooks';
import { initRegistry } from '../board/registry/init';
import { Body, DebugOverlay, Footer, Header, HelpDialog, Notification, getBodyViewportHeight } from '../board/views/index';
import type { Task, Project } from '../../types/board';
import type { Branch, Commit, Tag } from '../../lib/core/tracker/types';
import type { BacklogViewModel } from '../board/data/backlog-adapter';
import type { View } from '../board/types';
import { getBoardColumns, getBoardSelectionTarget, groupBacklogsByState } from '../board/board/model';

initRegistry();

interface Props {
  tasks: Task[];
  backlogs: BacklogViewModel[];
  projects: Project[];
  projectBranches: Branch[];
  projectTags: Tag[];
  projectCommits: Commit[];
  projectHasMore: boolean;
  onLoadProjectDetail: (project: Project) => void;
  onReloadTasks: () => Promise<unknown> | void;
  onReloadBacklogs: () => Promise<unknown> | void;
  onFetchMoreProjects: () => void;
  onInvalidateDetailCache: () => void;
  onAttachSession?: (task: Task) => void;
  onOpenTaskDiagnostics?: (task: Task) => void;
  onViewChange?: (view: View) => void;
}

export function AppContent({
  tasks,
  backlogs,
  projects,
  projectBranches,
  projectTags,
  projectCommits,
  projectHasMore,
  onLoadProjectDetail,
  onReloadTasks,
  onReloadBacklogs,
  onFetchMoreProjects,
  onInvalidateDetailCache,
  onAttachSession,
  onOpenTaskDiagnostics,
  onViewChange,
}: Props) {
  const { state, dispatch, currentView, currentContext, isDetailMode } = useAppState();
  const actions = createActions({ state, dispatch, currentView, currentContext, isDetailMode });
  const [dimensions, setDimensions] = useState({ width: process.stdout.columns || 80, height: process.stdout.rows || 24 });

  useEffect(() => {
    onViewChange?.(currentView);
  }, [currentView, onViewChange]);

  useEffect(() => {
    const interval = setInterval(() => {
      const width = process.stdout.columns || 80;
      const height = process.stdout.rows || 24;
      setDimensions(previous => previous.width === width && previous.height === height ? previous : { width, height });
    }, 500);
    return () => clearInterval(interval);
  }, []);

  const tasksRef = useRef<Task[]>([]);
  const backlogsRef = useRef<BacklogViewModel[]>([]);
  const projectsRef = useRef<Project[]>([]);
  tasksRef.current = tasks;
  backlogsRef.current = backlogs;
  projectsRef.current = projects;

  const getItems = (): Array<Task | BacklogViewModel | Project> => {
    const raw = currentView === 'tasks'
      ? tasksRef.current
      : currentView === 'backlogs' || currentView === 'board'
        ? backlogsRef.current
        : projectsRef.current;
    const query = state.searchQuery.trim().toLowerCase();
    if (!query) return raw;
    return raw.filter(item => {
      if ('title' in item && item.title?.toLowerCase().includes(query)) return true;
      if ('name' in item && item.name.toLowerCase().includes(query)) return true;
      if ('branch' in item && item.branch?.toLowerCase().includes(query)) return true;
      if ('branchName' in item && item.branchName.toLowerCase().includes(query)) return true;
      if ('tags' in item && item.tags.some(tag => tag.toLowerCase().includes(query))) return true;
      return false;
    });
  };

  const items = getItems();
  const selectedItem = () => items[state.selectedIndex];
  const viewportHeight = getBodyViewportHeight(dimensions.height, state.isSearchMode);
  const maxIndex = Math.max(0, items.length - 1);

  useEffect(() => {
    if (currentView === 'board') return;
    const offset = state.selectedIndex < state.scrollOffset
      ? state.selectedIndex
        : state.selectedIndex >= state.scrollOffset + viewportHeight
        ? Math.min(state.selectedIndex - viewportHeight + 1, maxIndex)
        : state.scrollOffset;
    if (offset !== state.scrollOffset) {
      dispatch({ type: 'selection:move', payload: { index: state.selectedIndex, scrollOffset: offset } });
    }
  }, [currentView, state.selectedIndex, state.scrollOffset, viewportHeight, maxIndex, dispatch]);

  useEffect(() => {
    if (isDetailMode && currentView === 'projects') {
      const project = selectedItem() as Project;
      if (project?.id) onLoadProjectDetail(project);
    }
  }, [isDetailMode, currentView, state.selectedIndex, onLoadProjectDetail]);

  const maybeLoadMoreProjects = useCallback(() => {
    if (currentView === 'projects' && projectHasMore && state.selectedIndex >= items.length - 3) {
      onFetchMoreProjects();
    }
  }, [currentView, projectHasMore, state.selectedIndex, items.length, onFetchMoreProjects]);

  useInput((input, key) => {
    if (input === '?') {
      actions.toggleHelp();
      return;
    }
    if (input === 'D' || input === 'd') {
      actions.toggleDebug();
      return;
    }
    if (input === '/') {
      actions.enableSearch();
      return;
    }
    if (state.isSearchMode) {
      if (key.escape || key.return) actions.disableSearch();
      else if (key.backspace) actions.backspaceSearch();
      else if (input.length === 1 && !key.ctrl && !key.meta) {
        actions.appendSearchChar(input);
        dispatch({ type: 'selection:top' });
      }
      return;
    }
    if (input === 'q') {
      process.exit(0);
      return;
    }
    if (key.escape) {
      if (state.showHelp) actions.toggleHelp();
      else if (isDetailMode) actions.viewList();
      else if (state.viewStack.length > 1) actions.goBack();
      return;
    }
    if (isDetailMode) {
      const item = selectedItem();
      if (input === 'o') {
        if (currentView === 'tasks' && item && onOpenTaskDiagnostics) {
          onOpenTaskDiagnostics(item as Task);
          return;
        }
        if (currentView === 'backlogs' || currentView === 'board') void actions.openBacklog(item as BacklogViewModel);
        else if (currentView === 'projects') {
          const project = item as Project;
          if (project?.web_url) void actions.openInBrowser(project.web_url, project.name);
          else actions.notify('no browser URL', 'warning');
        }
        return;
      }
      if (input === 'a' && currentView === 'tasks' && item && (item as Task).executionMode === 'interactive' && onAttachSession) onAttachSession(item as Task);
      if (input === 'b') actions.viewList();
      return;
    }
    if (input === 'b') {
      if (state.viewStack.length > 1) actions.goBack();
      return;
    }

    if (currentView === 'board') {
      const boardItems = items as BacklogViewModel[];
      const columns = getBoardColumns(groupBacklogsByState(boardItems));
      const currentId = boardItems[state.selectedIndex]?.id;
      const selectTarget = (direction: 'up' | 'down' | 'left' | 'right' | 'top' | 'bottom') => {
        const targetId = getBoardSelectionTarget(columns, currentId, direction);
        if (!targetId) return;
        const index = boardItems.findIndex(item => item.id === targetId);
        if (index >= 0) dispatch({ type: 'selection:move', payload: { index, scrollOffset: 0 } });
      };

      if (key.upArrow) { selectTarget('up'); return; }
      if (key.downArrow) { selectTarget('down'); return; }
      if (key.leftArrow) { selectTarget('left'); return; }
      if (key.rightArrow) { selectTarget('right'); return; }
      if (input === 'g') { selectTarget('top'); return; }
      if (key.shift && input === 'G') { selectTarget('bottom'); return; }
    }

    if (input === '1') actions.switchView('tasks');
    if (input === '2') actions.switchView('backlogs');
    if (input === '3') actions.switchView('projects');
    if (input === '4') actions.switchView('board');
    if (key.downArrow) {
      actions.selectionDown(items.length);
      maybeLoadMoreProjects();
    }
    if (key.upArrow) actions.selectionUp();
    if (input === 'g') actions.selectionTop();
    if (key.shift && input === 'G') actions.selectionBottom(items.length);
    if (key.return && items.length > 0) actions.viewDetail();
    if (input === 'r') {
      onInvalidateDetailCache();
      void Promise.all([onReloadTasks(), onReloadBacklogs()]).then(() => actions.notify('refreshed', 'success'));
    }
    if (input === 'o') {
      const item = selectedItem();
      if (currentView === 'tasks' && item && onOpenTaskDiagnostics) onOpenTaskDiagnostics(item as Task);
      else if (currentView === 'backlogs' || currentView === 'board') void actions.openBacklog(item as BacklogViewModel);
      else if (currentView === 'projects') {
        const project = item as Project;
        if (project?.web_url) void actions.openInBrowser(project.web_url, project.name);
        else actions.notify('no browser URL', 'warning');
      }
    }
    if ((input === 'a' || input === 'A') && currentView === 'tasks' && onAttachSession) {
      const task = selectedItem() as Task;
      if (task?.executionMode === 'interactive') onAttachSession(task);
    }
  });

  return (
      <Box flexDirection="column" height={dimensions.height} overflow="hidden">
      <Header view={currentView} tasksCount={tasks.length} backlogsCount={backlogs.length} projectsCount={projects.length} width={dimensions.width} />
      <Body
        view={currentView}
        detail={isDetailMode}
        search={state.isSearchMode}
        searchQuery={state.searchQuery}
        tasks={currentView === 'tasks' ? items as Task[] : []}
        backlogs={currentView === 'backlogs' || currentView === 'board' ? items as BacklogViewModel[] : []}
        projects={currentView === 'projects' ? items as Project[] : []}
        selectedIndex={state.selectedIndex}
        scrollOffset={state.scrollOffset}
        height={dimensions.height}
        width={dimensions.width}
        projectBranches={projectBranches}
        projectTags={projectTags}
        projectCommits={projectCommits}
        projectHasMore={projectHasMore}
      />
      <Footer view={currentView} detail={isDetailMode} search={isDetailMode ? false : state.isSearchMode} />
      <Notification notification={state.notification} animation={state.notifAnimation} />
      {state.showHelp && <HelpDialog view={currentView} detail={isDetailMode} />}
      {state.debugMode && <DebugOverlay logs={state.debugLog} />}
    </Box>
  );
}
