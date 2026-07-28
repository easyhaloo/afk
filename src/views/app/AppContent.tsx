/**
 * App - Main app component with declarative state-driven architecture
 */
import React, { useEffect, useCallback, useRef } from 'react';
import { Box, Text, useInput } from 'ink';
import { useState, createActions } from './hooks';
import { initRegistry } from '../dashboard/registry/init';
import { TaskListView, IssueListView, CompletedListView, ProjectListView, BoardView, DetailScreen, HelpDialog, BreathingSeparator, DebugOverlay, Header, Footer, Notification } from '../dashboard/views/index';
import { SplashScreen } from '../dashboard/components/SplashScreen.js';
import type { Task, Issue, Project } from '../../types/dashboard';

// Initialize view registry at module load
initRegistry();

interface Props {
  tasks: Task[];
  completedTasks: Task[];
  issues: Issue[];
  projects: Project[];
  sessions: any[];
  projectBranches: any[];
  projectTags: any[];
  projectCommits: any[];
  issueHasMore: boolean;
  projectHasMore: boolean;
  onLoadProjectDetail: (project: Project) => void;
  onReloadTasks: () => void;
  onRemoveSession: (name: string) => void;
  onAddTaskFromIssue: (issue: Issue, options: any) => Promise<Task>;
  onLaunchFromIssue: (issue: Issue, options: any) => Promise<void>;
  onLaunchExistingTask: (iid: number, session: string) => Promise<void>;
  onFetchMoreIssues: () => void;
  onFetchMoreProjects: () => void;
  onInvalidateDetailCache: () => void;
  onAttachSession?: (task: Task) => void;
}

export function AppContent({
  tasks, completedTasks, issues, projects, sessions,
  projectBranches, projectTags, projectCommits,
  issueHasMore, projectHasMore,
  onLoadProjectDetail, onReloadTasks, onRemoveSession,
  onAddTaskFromIssue, onLaunchFromIssue, onLaunchExistingTask,
  onFetchMoreIssues, onFetchMoreProjects, onInvalidateDetailCache,
  onAttachSession,
}: Props) {
  const { state, dispatch, currentView, currentContext, isDetailMode } = useState();
  const actions = createActions({ state, dispatch, currentView, currentContext, isDetailMode });

  const [showSplash, setShowSplash] = React.useState(true);
  const [fadeInMain, setFadeInMain] = React.useState(false);

  const W = process.stdout.columns || 80;
  const H = process.stdout.rows || 24;
  const CONTENT_H = H - 2;

  // Refs for stable access
  const tasksRef = useRef<Task[]>([]);
  const issuesRef = useRef<Issue[]>([]);
  const projectsRef = useRef<Project[]>([]);
  const completedTasksRef = useRef<Task[]>([]);
  tasksRef.current = tasks;
  issuesRef.current = issues;
  projectsRef.current = projects;
  completedTasksRef.current = completedTasks;

  // Get items based on current view
  const getItems = (): (Task | Issue | Project)[] => {
    let raw: (Task | Issue | Project)[] = [];
    if (currentView === 'tasks') raw = tasksRef.current;
    else if (currentView === 'issues') raw = issuesRef.current;
    else if (currentView === 'completed') raw = completedTasksRef.current;
    else if (currentView === 'board') raw = issuesRef.current;
    else raw = projectsRef.current;

    if (!state.searchQuery.trim()) return raw;

    const q = state.searchQuery.toLowerCase();
    return raw.filter(item => {
      if ('title' in item && item.title) return item.title.toLowerCase().includes(q);
      if ('name' in item && item.name) return item.name.toLowerCase().includes(q);
      if ('branch' in item && item.branch) return item.branch.toLowerCase().includes(q);
      if ('labels' in item && item.labels) return item.labels.some(l => l.toLowerCase().includes(q));
      return false;
    });
  };

  const items = getItems();
  const getItem = () => items[state.selectedIndex];

  const viewportHeight = Math.floor((CONTENT_H - 2) / 1);

  // Smooth fade-in
  useEffect(() => {
    if (!showSplash && fadeInMain) {
      let frame = 0;
      const t = setInterval(() => {
        frame++;
        if (frame >= 10) clearInterval(t);
      }, 30);
      return () => clearInterval(t);
    }
  }, [showSplash, fadeInMain]);

  // Auto-load project detail
  useEffect(() => {
    if (isDetailMode && currentView === 'projects') {
      const project = getItem() as Project;
      if (project?.id) onLoadProjectDetail(project);
    }
  }, [isDetailMode, currentView]);

  // Auto-load more
  const handleSelectionChange = useCallback(() => {
    if (state.selectedIndex >= items.length - 3) {
      if (currentView === 'issues' && issueHasMore) onFetchMoreIssues();
      else if (currentView === 'projects' && projectHasMore) onFetchMoreProjects();
    }
  }, [state.selectedIndex, items.length, currentView, issueHasMore, projectHasMore]);

  // Keyboard input
  useInput((input, key) => {
    // Help toggle
    if (input === '?') { actions.toggleHelp(); return; }

    // Debug toggle
    if (input === 'D' || input === 'd') { actions.toggleDebug(); return; }

    // Search mode
    if (input === '/') {
      actions.enableSearch();
      return;
    }
    if (state.isSearchMode) {
      if (key.escape) { actions.disableSearch(); return; }
      if (key.backspace) { actions.backspaceSearch(); return; }
      if (key.return) { actions.disableSearch(); return; }
      if (input.length === 1 && !key.ctrl && !key.meta) {
        actions.appendSearchChar(input);
        dispatch({ type: 'selection:top' });
        return;
      }
      return;
    }

    // Escape / Quit
    if (key.escape || input === 'q') {
      if (state.showHelp) { actions.toggleHelp(); return; }
      if (input === 'q') { process.exit(0); }
      if (isDetailMode) { process.exit(0); }
      if (state.viewStack.length > 1) { actions.goBack(); return; }
      return;
    }

    // Detail mode
    if (isDetailMode) {
      if (input === 'o') {
        const item = getItem();
        const url = currentView === 'issues' ? (item as Issue)?.web_url : (item as Project)?.web_url;
        if (url) actions.openInBrowser(url);
        return;
      }
      if (input === 'b') { actions.viewList(); return; }
      if (input === 'i' && currentView === 'projects') {
        const project = getItem() as Project;
        if (project) actions.viewIssues(project);
        return;
      }
      if (input === 'a' && currentView === 'tasks' && onAttachSession) {
        const task = getItem() as Task;
        if (task) onAttachSession(task);
        return;
      }
      return;
    }

    // Back
    if (input === 'b') {
      if (state.viewStack.length > 1) actions.goBack();
      return;
    }

    // View switching
    if (input === '1') actions.switchView('tasks');
    if (input === '2') actions.switchView('issues');
    if (input === '3') actions.switchView('completed');
    if (input === '4') actions.switchView('projects');
    if (input === '5') actions.switchView('board');

    // Navigation
    if (key.downArrow) {
      actions.selectionDown(items.length);
      handleSelectionChange();
    }
    if (key.upArrow) actions.selectionUp();
    if (input === 'g') actions.selectionTop();
    if (key.shift && input === 'G') actions.selectionBottom(items.length);

    // Enter detail
    if (key.return) { actions.viewDetail(); return; }

    // Refresh
    if (input === 'r') {
      onInvalidateDetailCache();
      onReloadTasks();
      actions.notify('done', 'success');
    }

    // Multi-select mode
    if (state.multiSelectMode) {
      if (input === ' ') {
        const issue = getItem() as Issue;
        if (issue) actions.toggleItem(issue.iid);
        return;
      }
      if (input === 'B') {
        actions.notify(`creating ${state.selectedItems.size} tasks...`, 'info');
        return;
      }
      if (input === 'c') actions.clearSelection();
      if (key.escape) {
        dispatch({ type: 'multi-select:toggle' });
        actions.notify('exit multi-select', 'info');
      }
      return;
    }

    // Issue-specific actions
    if (currentView === 'issues') {
      if (input === 'm') { actions.toggleMultiSelect(); return; }
      if (input === 's') {
        const issue = getItem() as Issue;
        if (!issue) return;
        actions.notify(`creating task from #${issue.iid}...`, 'info');
        const branch = `issue-${issue.iid}-${issue.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 30)}`;
        onAddTaskFromIssue(issue, { branch, session: `issue-${issue.iid}`, worktree: branch })
          .then(() => {
            onReloadTasks();
            dispatch({ type: 'dispatch', payload: { type: 'issue:create-task' } });
            actions.notify(`created task #${issue.iid}`, 'success');
          })
          .catch(() => actions.notify('create failed', 'error'));
        return;
      }
      if (input === 'l') {
        const issue = getItem() as Issue;
        if (!issue) return;
        actions.notify(`launching #${issue.iid}...`, 'info');
        const branch = `issue-${issue.iid}-${issue.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 30)}`;
        onLaunchFromIssue(issue, { branch, session: `issue-${issue.iid}`, worktree: branch })
          .then(() => {
            onReloadTasks();
            dispatch({ type: 'dispatch', payload: { type: 'issue:launch' } });
            actions.notify(`launched: issue-${issue.iid}`, 'success');
          })
          .catch(() => actions.notify('launch failed', 'error'));
        return;
      }
      if (input === 'o') {
        const issue = getItem() as Issue;
        if (issue?.web_url) actions.openInBrowser(issue.web_url, `#${issue.iid}`);
        return;
      }
    }

    // Task-specific actions
    if (currentView === 'tasks') {
      if ((input === 'a' || input === 'A') && onAttachSession) {
        const task = getItem() as Task;
        if (task) onAttachSession(task);
        return;
      }
      if (input === 'k' || input === 'K') {
        const task = getItem() as Task;
        if (task?.session) {
          onRemoveSession(task.session);
          actions.notify(`killed: ${task.session}`, 'success');
        }
        return;
      }
      if (input === 'l' || input === 'L') {
        const task = getItem() as Task;
        if (task?.session) {
          onLaunchExistingTask(task.iid, task.session);
          actions.notify(`launched: ${task.session}`, 'success');
        }
        return;
      }
    }

    // Project-specific actions
    if (currentView === 'projects') {
      if (input === 'o') {
        const project = getItem() as Project;
        if (project?.web_url) actions.openInBrowser(project.web_url, project.name);
        return;
      }
    }
  });

  // View title
  const viewTitle = (() => {
    const filtered = state.searchQuery ? ` (${items.length}/${tasks.length + issues.length + completedTasks.length + projects.length})` : '';
    if (currentView === 'tasks') return `tasks running: ${items.length}${filtered}`;
    if (currentView === 'issues') return state.multiSelectMode
      ? `issues todo: ${items.length} | selected: ${state.selectedItems.size}`
      : `issues todo: ${items.length}${filtered}`;
    if (currentView === 'completed') return `completed: ${items.length}${filtered}`;
    if (currentView === 'board') return `board view: ${items.length} issues${filtered}`;
    return `gitlab projects: ${items.length}${filtered}`;
  })();

  if (showSplash) {
    return <SplashScreen onComplete={() => { setShowSplash(false); setFadeInMain(true); }} duration={2500} />;
  }

  return (
    <Box flexDirection="column" height={H}>
      {isDetailMode ? (
        <DetailScreen
          item={getItem()}
          view={currentView}
          height={H}
          width={W}
          branches={projectBranches}
          tags={projectTags}
          commits={projectCommits}
        />
      ) : (
        <>
          <Header
            view={currentView}
            tasksCount={tasks.length}
            issuesCount={issues.length}
            completedCount={completedTasks.length}
            projectsCount={projects.length}
            selectedIssuesCount={state.selectedItems.size}
            multiSelectMode={state.multiSelectMode}
          />
          <BreathingSeparator width={W} breathPhase={state.separatorPhase} isTop />
          <Box paddingX={2} paddingY={0}>
            <Text color="white"><Text bold>{viewTitle}</Text></Text>
            {state.isSearchMode && (
              <Text color="cyan"> │ /{state.searchQuery}_</Text>
            )}
          </Box>
          <Box position="relative" flexGrow={1} flexShrink={1} flexDirection="column" paddingX={2} paddingY={0}>
            {currentView === 'tasks' && <TaskListView tasks={items as Task[]} selected={state.selectedIndex} scrollOffset={state.scrollOffset} viewportHeight={viewportHeight} />}
            {currentView === 'issues' && <IssueListView issues={items as Issue[]} selected={state.selectedIndex} scrollOffset={state.scrollOffset} viewportHeight={viewportHeight} multiSelectMode={state.multiSelectMode} selectedIssues={state.selectedItems} />}
            {currentView === 'completed' && <CompletedListView tasks={items as Task[]} selected={state.selectedIndex} scrollOffset={state.scrollOffset} viewportHeight={viewportHeight} />}
            {currentView === 'projects' && <ProjectListView projects={items as Project[]} selected={state.selectedIndex} scrollOffset={state.scrollOffset} viewportHeight={viewportHeight} />}
            {currentView === 'board' && <BoardView issues={items as Issue[]} selectedIndex={state.selectedIndex} scrollOffset={state.scrollOffset} viewportHeight={viewportHeight} />}
            {(currentView === 'issues' && issueHasMore || currentView === 'projects' && projectHasMore) && (
              <Box position="absolute" right={2} bottom={0}>
                <Text dimColor>↓ more available</Text>
              </Box>
            )}
          </Box>
          <BreathingSeparator width={W} breathPhase={state.separatorPhase + 50} isTop={false} />
          <Footer />
          <Notification notification={state.notification} animation={state.notifAnimation} />
          {state.showHelp && <HelpDialog />}
          {state.debugMode && <DebugOverlay logs={state.debugLog} />}
        </>
      )}
    </Box>
  );
}
