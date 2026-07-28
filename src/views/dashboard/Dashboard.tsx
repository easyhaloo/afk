import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Box, Text, useInput, useApp } from 'ink';
import figures from 'figures';
import { tmux as createTmux } from 'node-tmux';
import { exec } from 'child_process';
import { Task, Issue, Project } from '../../types/dashboard';
import { useNavigation } from './navigation/index';
import { useData } from './data/index';
import {
  TaskListView,
  IssueListView,
  CompletedListView,
  ProjectListView,
  BoardView,
  DetailScreen,
  HelpDialog,
  BreathingSeparator,
  DebugOverlay,
  Header,
  Footer,
  Notification,
} from './views/index';
import { SplashScreen } from './components/SplashScreen.js';
import type { View, Notification as NotificationType } from './types';

export const Dashboard: React.FC = () => {
  const { exit } = useApp();
  const [showSplash, setShowSplash] = useState(true);
  const [fadeInMain, setFadeInMain] = useState(false);
  const [mainOpacity, setMainOpacity] = useState(0);
  const W = process.stdout.columns || 80;
  const H = process.stdout.rows || 24;
  const CONTENT_H = H - 2;

  // When the user enters issue view from a project (key `i` in detail) we
  // scope the fetch to that project; otherwise it's null and the service
  // falls back to all accessible projects.
  const [issueProject, setIssueProject] = useState<Project | null>(null);

  const {
    currentView, setCurrentView,
    selectedIndex, setSelectedIndex,
    scrollOffset, setScrollOffset,
    detailView, setDetailView, isDetailMode,
    pushView, popView, canGoBack, switchView,
    navigateDown, navigateUp, navigateTop, navigateBottom,
  } = useNavigation();

  const {
    tasks, completedTasks, issues, projects, sessions,
    projectBranches, projectTags, projectCommits,
    issueHasMore, projectHasMore,
    loadProjectDetail,
    reloadTasks, removeSession, addTaskFromIssue, launchFromIssue, launchExistingTask,
    fetchMoreIssues, fetchMoreProjects,
    invalidateDetailCache,
  } = useData(currentView, issueProject);

  // UI state
  const [multiSelectMode, setMultiSelectMode] = useState(false);
  const [selectedIssues, setSelectedIssues] = useState<Set<number>>(new Set());
  const [showHelp, setShowHelp] = useState(false);
  const [notification, setNotification] = useState<NotificationType | null>(null);
  const [notifAnimation, setNotifAnimation] = useState<'hidden' | 'slide-in' | 'visible' | 'slide-out'>('hidden');
  const [separatorPhase, setSeparatorPhase] = useState(0);

  // Debug state
  const [debugMode, setDebugMode] = useState(false);
  const [debugLog, setDebugLog] = useState<string[]>([]);
  const prevSelectedRef = useRef<number | null>(null);
  const itemsRef = useRef<(Task | Issue | Project)[]>([]);
  const addDebugLog = (msg: string) =>
    setDebugLog(prev => [...prev.slice(-20), `${new Date().toLocaleTimeString()} ${msg}`]);

  // Refs to avoid stale closure in callbacks
  const tasksRef = useRef<Task[]>([]);
  const issuesRef = useRef<Issue[]>([]);
  const projectsRef = useRef<Project[]>([]);
  const completedTasksRef = useRef<Task[]>([]);
  tasksRef.current = tasks;
  issuesRef.current = issues;
  projectsRef.current = projects;
  completedTasksRef.current = completedTasks;

  // Derived
  const getItems = (): (Task | Issue | Project)[] => {
    if (currentView === 'tasks') return tasksRef.current;
    if (currentView === 'issues') return issuesRef.current;
    if (currentView === 'completed') return completedTasksRef.current;
    if (currentView === 'board') return issuesRef.current; // Board view uses issues
    return projectsRef.current;
  };
  itemsRef.current = getItems();
  const getItem = () => getItems()[selectedIndex];

  const ROWS_PER_ITEM = 1; // Each item is rendered as a single compact line.
  const items = getItems();
  const maxIndex = Math.max(0, items.length - 1);
  const viewportHeight = Math.floor((CONTENT_H - 2) / ROWS_PER_ITEM);

  const desiredScrollOffset =
    selectedIndex < scrollOffset
      ? selectedIndex
      : selectedIndex >= scrollOffset + viewportHeight
        ? Math.min(selectedIndex - viewportHeight + 1, maxIndex)
        : scrollOffset;
  if (desiredScrollOffset !== scrollOffset) {
    setScrollOffset(desiredScrollOffset);
  }

  // Notifications
  const notify = useCallback((message: string, type: NotificationType['type'] = 'info') => {
    setNotifAnimation('slide-in');
    setNotification({ message, type });
    setTimeout(() => setNotifAnimation('visible'), 150);
    setTimeout(() => { setNotifAnimation('slide-out'); }, 2700);
    setTimeout(() => { setNotifAnimation('hidden'); setNotification(null); }, 3000);
  }, []);

  // Smooth fade-in effect for main dashboard after splash
  useEffect(() => {
    if (!showSplash && fadeInMain) {
      let frame = 0;
      const totalFrames = 10;
      const fadeInterval = setInterval(() => {
        frame++;
        setMainOpacity(frame / totalFrames);
        if (frame >= totalFrames) {
          clearInterval(fadeInterval);
        }
      }, 30);
      return () => clearInterval(fadeInterval);
    }
  }, [showSplash, fadeInMain]);

  // Handlers
  const handleAttachSession = useCallback(async () => {
    const task = getItem() as Task;
    // Derive session name - use ref-based getItems() to avoid stale closure
    const sessionName = task?.session
      || (task?.platform === 'github' ? `afk-gh-${task.iid}` : null)
      || (task?.platform === 'gitlab' ? `afk-gl-${task.iid}` : null)
      || (task?.iid ? `afk-gl-${task.iid}` : null);
    if (!sessionName) { notify('no task selected', 'warning'); return; }
    try {
      const tmux = await createTmux();
      if (!tmux) { notify('tmux unavailable', 'error'); return; }
      if (!await tmux.hasSession(sessionName)) { notify(`session ${sessionName} not found`, 'error'); return; }
      exit();
      const { spawnSync, spawn } = require('child_process');
      const result = spawnSync('tmux', ['attach-session', '-t', sessionName], { stdio: 'inherit' });
      if (result.status === 0) {
        console.log(`\n${figures.tick} detached from \x1b[37m${sessionName}\x1b[0m`);
        console.log('returning to Dashboard...\n');
        await new Promise(r => setTimeout(r, 1000));
        spawn(process.argv[0], process.argv.slice(1), { stdio: 'inherit' });
      } else {
        console.error(`\n${figures.cross} attach failed`);
        process.exit(1);
      }
    } catch { notify('attach failed', 'error'); process.exit(1); }
  }, [currentView]);

  const handleKillSession = useCallback(async () => {
    if (currentView !== 'tasks') return;
    const task = getItem() as Task;
    if (!task?.session) { notify('no session', 'warning'); return; }
    try {
      await removeSession(task.session);
      notify(`killed: ${task.session}`, 'success');
    } catch (e) { notify(`kill failed: ${e}`, 'error'); }
  }, [currentView]);

  const handleStartFromIssue = useCallback(async () => {
    if (currentView !== 'issues') return;
    const issue = getItem() as Issue;
    if (!issue) return;
    notify(`creating task from #${issue.iid}...`, 'info');
    const branch = `issue-${issue.iid}-${issue.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 30)}`;
    try {
      const newTask = await addTaskFromIssue(issue, { branch, session: `issue-${issue.iid}`, worktree: branch });
      await reloadTasks();
      setCurrentView('tasks');
      setSelectedIndex(0);
      notify(`created task #${newTask.iid}: ${newTask.title}`, 'success');
    } catch { notify('create failed', 'error'); }
  }, [currentView]);

  const handleLaunch = useCallback(async () => {
    if (currentView === 'issues') {
      const issue = getItem() as Issue;
      if (!issue) return;
      notify(`launching #${issue.iid}...`, 'info');
      const branch = `issue-${issue.iid}-${issue.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 30)}`;
      try {
        await launchFromIssue(issue, { branch, session: `issue-${issue.iid}`, worktree: branch });
        await reloadTasks();
        setCurrentView('tasks');
        setSelectedIndex(0);
        notify(`launched: issue-${issue.iid}`, 'success');
      } catch { notify('launch failed', 'error'); }
    } else if (currentView === 'tasks') {
      const task = getItem() as Task;
      if (!task?.session) { notify('no session', 'warning'); return; }
      try {
        await launchExistingTask(task.iid, task.session);
        notify(`launched: ${task.session}`, 'success');
      } catch { notify('launch failed', 'error'); }
    }
  }, [currentView, launchFromIssue, launchExistingTask]);

  const handleOpenInBrowser = useCallback(async () => {
    const item = itemsRef.current[selectedIndex];
    const url = currentView === 'issues'
      ? (item as Issue)?.web_url
      : (item as Project)?.web_url as string;
    if (!url) return;
    const cmd = process.platform === 'darwin'
      ? `open "${url}"`
      : process.platform === 'win32'
        ? `start "" "${url}"`
        : `xdg-open "${url}"`;
    exec(cmd, (err) => {
      if (err) notify('open failed', 'error');
      else notify(`opened ${currentView === 'issues' ? `#${(item as Issue).iid}` : (item as Project).name}`, 'success');
    });
  }, [currentView, selectedIndex]);

  const toggleMultiSelectMode = useCallback(() => {
    if (currentView !== 'issues') return;
    setMultiSelectMode(m => {
      const next = !m;
      notify(next ? 'enter multi-select (Space to select)' : 'exit multi-select', 'info');
      return next;
    });
    setSelectedIssues(new Set());
  }, [currentView]);

  const toggleIssueSelection = useCallback(() => {
    if (currentView !== 'issues' || !multiSelectMode) return;
    const issue = getItem() as Issue;
    if (!issue) return;
    setSelectedIssues(s => {
      const next = new Set(s);
      next.has(issue.iid) ? next.delete(issue.iid) : next.add(issue.iid);
      return next;
    });
  }, [currentView, multiSelectMode]);

  const handleBatchStart = useCallback(async () => {
    if (currentView !== 'issues' || selectedIssues.size === 0) { notify('no issues selected', 'warning'); return; }
    notify(`creating ${selectedIssues.size} tasks...`, 'info');
    let ok = 0;
    for (const iid of selectedIssues) {
      const issue = issues.find(i => i.iid === iid);
      if (!issue) continue;
      const branch = `issue-${issue.iid}-${issue.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 30)}`;
      try {
        await addTaskFromIssue(issue, { branch, session: `issue-${issue.iid}`, worktree: branch });
        ok++;
      } catch { /* skip */ }
    }
    await reloadTasks();
    setSelectedIssues(new Set());
    setMultiSelectMode(false);
    setCurrentView('tasks');
    setSelectedIndex(0);
    notify(`created ${ok} tasks`, 'success');
  }, [currentView, selectedIssues, issues]);

  const clearSelections = useCallback(() => {
    setSelectedIssues(new Set());
    notify('cleared', 'info');
  }, []);

  const handleRefresh = useCallback(async () => {
    notify('refreshing...', 'info');
    invalidateDetailCache();
    await reloadTasks();
    notify('done', 'success');
  }, [invalidateDetailCache, reloadTasks]);

  // Animations — paused while in detail mode to avoid wasted re-renders.
  useEffect(() => {
    if (isDetailMode) return;
    const t = setInterval(() => setSeparatorPhase(p => (p + 1) % 100), 500);
    return () => clearInterval(t);
  }, [isDetailMode]);

  // Auto-select when there's only one item
  useEffect(() => {
    const items = getItems();
    if (items.length === 1 && selectedIndex === 0) {
      // Already selected, no-op
    }
  }, [tasks, issues, projects, completedTasks, selectedIndex]);

  // Debug logging
  useEffect(() => {
    if (!debugMode) return;
    const prev = prevSelectedRef.current;
    if (prev !== null && prev !== selectedIndex) {
      const prevItems = getItems();
      addDebugLog(`[LEAVE] idx=${prev} item=${prevItems[prev] ? serialize(prevItems[prev]) : '?'}`);
    }
    addDebugLog(`[ENTER] idx=${selectedIndex} item=${serialize(getItem())}`);
    prevSelectedRef.current = selectedIndex;
  }, [selectedIndex, debugMode]);

  // Auto-load project detail
  useEffect(() => {
    if (detailView === 'detail' && currentView === 'projects') {
      const project = getItem() as Project;
      if (project?.id) loadProjectDetail(project);
    }
  }, [detailView, currentView]);

  // Keyboard input
  useInput((input, key) => {
    if (input === '?') { setShowHelp(h => !h); return; }
    if (input === 'D' || input === 'd') { setDebugMode(d => { const n = !d; addDebugLog(`[DEBUG ${n ? 'ON' : 'OFF'}]`); return n; }); return; }

    if (key.escape || input === 'q') {
      if (showHelp) { setShowHelp(false); return; }
      if (input === 'q') { exit(); return; }
      if (detailView === 'detail') { exit(); return; }
      if (canGoBack()) { popView(); setIssueProject(null); return; }
      return;
    }

    if (detailView === 'detail') {
      if (input === 'o') { handleOpenInBrowser(); return; }
      if (input === 'D' || input === 'd') { setDebugMode(d => { const n = !d; addDebugLog(`[DEBUG ${n ? 'ON' : 'OFF'}]`); return n; }); return; }
      if (input === 'a' && currentView === 'tasks') { handleAttachSession(); return; }
      if (input === 'b') { setDetailView('list'); return; }
      if (input === 'i') {
        const project = getItem() as Project;
        if (project) {
          setIssueProject(project);
          setCurrentView('issues');
          setDetailView('list');
          setSelectedIndex(0);
        }
        return;
      }
      return;
    }

    if (input === 'b') {
      if (showHelp) { setShowHelp(false); return; }
      if (canGoBack()) { popView(); setIssueProject(null); return; }
    }

    if (input === '1') { setIssueProject(null); switchView('tasks'); }
    if (input === '2') { setIssueProject(null); switchView('issues'); }
    if (input === '3') { setIssueProject(null); switchView('completed'); }
    if (input === '4') { setIssueProject(null); switchView('projects'); }
    if (input === '5') { setIssueProject(null); switchView('board'); }

    if (key.downArrow) {
      navigateDown(items.length);
      // Auto-load next page when selection reaches near the end of loaded items.
      if (selectedIndex >= items.length - 3) {
        if (currentView === 'issues' && issueHasMore) fetchMoreIssues();
        else if (currentView === 'projects' && projectHasMore) fetchMoreProjects();
      }
    }
    if (key.upArrow) navigateUp();
    if (input === 'g') navigateTop();
    if (key.shift && input === 'G') navigateBottom(items.length);

    if (key.return) { setDetailView('detail'); return; }

    if (key.escape && canGoBack()) { popView(); return; }

    if (input === 'r') handleRefresh();

    if (currentView === 'tasks') {
      if (input === 'a' || input === 'A') handleAttachSession();
      if (input === 'k' || input === 'K') handleKillSession();
      if (input === 'l' || input === 'L') handleLaunch();
    }

    if (currentView === 'issues') {
      if (input === 'm') { toggleMultiSelectMode(); return; }
      if (multiSelectMode) {
        if (input === ' ') toggleIssueSelection();
        if (input === 'B') handleBatchStart();
        if (input === 'c') clearSelections();
        if (key.escape) { setMultiSelectMode(false); setSelectedIssues(new Set()); }
      } else {
        if (input === 's') handleStartFromIssue();
        if (input === 'o') handleOpenInBrowser();
        if (input === 'l') handleLaunch();
      }
    }

    if (currentView === 'projects') {
      if (input === 'o') handleOpenInBrowser();
    }
  });

  // View title
  const viewTitle = (() => {
    if (currentView === 'tasks') return `tasks running: ${tasks.length}`;
    if (currentView === 'issues') return multiSelectMode
      ? `issues todo: ${issues.length} | selected: ${selectedIssues.size}`
      : `issues todo: ${issues.length}`;
    if (currentView === 'completed') return `completed: ${completedTasks.length}`;
    if (currentView === 'board') return `board view: ${issues.length} issues`;
    return `gitlab projects: ${projects.length}`;
  })();

  return showSplash ? (
    <SplashScreen onComplete={() => {
      setShowSplash(false);
      setFadeInMain(true);
    }} duration={2500} />
  ) : (
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
            selectedIssuesCount={selectedIssues.size}
            multiSelectMode={multiSelectMode}
          />
          <BreathingSeparator width={W} breathPhase={separatorPhase} isTop />
          <Box paddingX={2} paddingY={0}>
            <Text color="white"><Text bold>{viewTitle}</Text></Text>
          </Box>
          <Box position="relative" flexGrow={1} flexShrink={1} flexDirection="column" paddingX={2} paddingY={0}>
            {currentView === 'tasks' && <TaskListView tasks={tasks} selected={selectedIndex} scrollOffset={scrollOffset} viewportHeight={viewportHeight} />}
            {currentView === 'issues' && <IssueListView issues={issues} selected={selectedIndex} scrollOffset={scrollOffset} viewportHeight={viewportHeight} multiSelectMode={multiSelectMode} selectedIssues={selectedIssues} />}
            {currentView === 'completed' && <CompletedListView tasks={completedTasks} selected={selectedIndex} scrollOffset={scrollOffset} viewportHeight={viewportHeight} />}
            {currentView === 'projects' && <ProjectListView projects={projects} selected={selectedIndex} scrollOffset={scrollOffset} viewportHeight={viewportHeight} />}
            {currentView === 'board' && <BoardView issues={issues} selectedIndex={selectedIndex} scrollOffset={scrollOffset} viewportHeight={viewportHeight} />}
            {/* Floating loading/more indicator — overlays the list, does not consume layout space. */}
            {(
              (currentView === 'issues' && issueHasMore) ||
              (currentView === 'projects' && projectHasMore)
            ) && (
              <Box position="absolute" right={2} bottom={0}>
                <Text dimColor>↓ more available</Text>
              </Box>
            )}
          </Box>
          <BreathingSeparator width={W} breathPhase={separatorPhase + 50} isTop={false} />
          <Footer />
          <Notification notification={notification} animation={notifAnimation} />
          {showHelp && <HelpDialog />}
          {debugMode && <DebugOverlay logs={debugLog} />}
        </>
      )}
    </Box>
  );
};

function serialize(item: Task | Issue | Project | undefined): string {
  if (!item) return 'none';
  if ('name' in item) return JSON.stringify({ id: (item as Project).id, name: (item as Project).name });
  if ('title' in item) return JSON.stringify({ id: (item as Issue).iid, title: (item as Issue).title });
  return JSON.stringify({ id: (item as Task).iid });
}
