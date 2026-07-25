import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Box, Text, useInput, useApp } from 'ink';
import figures from 'figures';
import { tmux as createTmux } from 'node-tmux';
import open from 'open';
import { Task, Issue, Project } from '../../types/dashboard';
import { useNavigation } from './navigation/index.js';
import { useData } from './data/index.js';
import {
  TaskListView,
  IssueListView,
  CompletedListView,
  ProjectListView,
  DetailScreen,
  HelpDialog,
  BreathingSeparator,
  DebugOverlay,
  Header,
  Footer,
  Notification,
} from './views/index.js';
import type { View, Notification as NotificationType } from './types';

export const Dashboard: React.FC = () => {
  const { exit } = useApp();
  const W = process.stdout.columns || 80;
  const H = process.stdout.rows || 24;
  const CONTENT_H = H - 2;

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
    loadProjectDetail,
    reloadTasks, removeSession, addTaskFromIssue,
  } = useData(currentView, null);

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
  const addDebugLog = (msg: string) =>
    setDebugLog(prev => [...prev.slice(-20), `${new Date().toLocaleTimeString()} ${msg}`]);

  // Derived
  const getItems = (): (Task | Issue | Project)[] => {
    if (currentView === 'tasks') return tasks;
    if (currentView === 'issues') return issues;
    if (currentView === 'completed') return completedTasks;
    return projects;
  };
  const getItem = () => getItems()[selectedIndex];

  const itemHeight = currentView === 'completed' ? 3 : 4;
  const items = getItems();
  const maxIndex = Math.max(0, items.length - 1);
  const itemsPerScreen = Math.floor(CONTENT_H / itemHeight);

  let desiredScrollOffset = scrollOffset;
  if (selectedIndex < scrollOffset) {
    desiredScrollOffset = selectedIndex;
  } else if (selectedIndex >= scrollOffset + itemsPerScreen) {
    desiredScrollOffset = Math.min(selectedIndex - itemsPerScreen + 1, maxIndex);
  }
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

  // Handlers
  const handleAttachSession = useCallback(async () => {
    if (currentView !== 'tasks') return;
    const task = getItem() as Task;
    if (!task?.session) { notify('no session', 'warning'); return; }
    try {
      const tmux = await createTmux();
      if (!tmux) { notify('tmux unavailable', 'error'); return; }
      if (!await tmux.hasSession(task.session)) { notify(`session ${task.session} not found`, 'error'); return; }
      exit();
      const { spawnSync, spawn } = require('child_process');
      const result = spawnSync('tmux', ['attach-session', '-t', task.session], { stdio: 'inherit' });
      if (result.status === 0) {
        console.log(`\n${figures.tick} detached from \x1b[37m${task.session}\x1b[0m`);
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

  const handleOpenInBrowser = useCallback(async () => {
    const item = getItem();
    if (currentView === 'issues' && (item as Issue)?.web_url) {
      try { await open((item as Issue).web_url); notify(`opened #${(item as Issue).iid}`, 'success'); }
      catch { notify('open failed', 'error'); }
    } else if (currentView === 'projects' && (item as Project)?.web_url) {
      try { await open((item as Project).web_url as string); notify(`opened ${(item as Project).name}`, 'success'); }
      catch { notify('open failed', 'error'); }
    }
  }, [currentView]);

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
    await reloadTasks();
    notify('done', 'success');
  }, []);

  // Animations
  useEffect(() => {
    const t = setInterval(() => setSeparatorPhase(p => (p + 1) % 100), 500);
    return () => clearInterval(t);
  }, []);

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

    if (input === 'b') {
      if (showHelp) { setShowHelp(false); return; }
      if (detailView === 'detail') { setDetailView('list'); return; }
      if (canGoBack()) { popView(); return; }
    }

    if (key.escape || input === 'q') {
      if (showHelp) { setShowHelp(false); return; }
      if (detailView === 'detail') { setDetailView('list'); return; }
      if (input === 'q') { exit(); return; }
    }

    if (detailView === 'detail' && input === 'i') {
      const project = getItem() as Project;
      if (project) { setCurrentView('issues'); setDetailView('list'); }
      return;
    }

    if (showHelp || detailView === 'detail') return;

    if (input === '1') switchView('tasks');
    if (input === '2') switchView('issues');
    if (input === '3') switchView('completed');
    if (input === '4') switchView('projects');

    if (key.downArrow) navigateDown(items.length);
    if (key.upArrow) navigateUp();
    if (input === 'g') navigateTop();
    if (key.shift && input === 'G') navigateBottom(items.length);

    if (key.return) {
      if (currentView === 'projects') setDetailView('detail');
      else setDetailView('detail');
      return;
    }

    if (key.escape && canGoBack()) { popView(); return; }

    if (input === 'r') handleRefresh();

    if (currentView === 'tasks') {
      if (input === 'a') handleAttachSession();
      if (input === 'k' || input === 'K') handleKillSession();
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
    return `gitlab projects: ${projects.length}`;
  })();

  const viewportH = Math.floor((CONTENT_H - 2) / itemHeight);

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
            selectedIssuesCount={selectedIssues.size}
            multiSelectMode={multiSelectMode}
          />
          <BreathingSeparator width={W} breathPhase={separatorPhase} isTop />
          <Box paddingX={2} paddingY={0}>
            <Text color="white"><Text bold>{viewTitle}</Text><Text>  </Text><Text color="gray">──</Text></Text>
          </Box>
          <Box height={CONTENT_H - 2} flexShrink={0} flexDirection="column" paddingX={2} paddingY={0}>
            {currentView === 'tasks' && <TaskListView tasks={tasks} selected={selectedIndex} scrollOffset={scrollOffset} viewportHeight={viewportH} />}
            {currentView === 'issues' && <IssueListView issues={issues} selected={selectedIndex} scrollOffset={scrollOffset} viewportHeight={viewportH} multiSelectMode={multiSelectMode} selectedIssues={selectedIssues} />}
            {currentView === 'completed' && <CompletedListView tasks={completedTasks} selected={selectedIndex} scrollOffset={scrollOffset} viewportHeight={viewportH} />}
            {currentView === 'projects' && <ProjectListView projects={projects} selected={selectedIndex} scrollOffset={scrollOffset} viewportHeight={viewportH} />}
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
