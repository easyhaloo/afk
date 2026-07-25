/**
 * AFK Dashboard - Single View Mode
 * Full-screen single view with quick switching
 */

import React, { useState, useEffect, useCallback } from 'react';
import { Box, Text, useInput, useApp } from 'ink';
import figures from 'figures';
import { tmux as createTmux } from 'node-tmux';
import { Task, TmuxSession, Issue } from '../types/dashboard';
import { TaskService } from './task-service';
import { SessionService } from './session-service';
import { IssueService } from './issue-service';
import { ProjectService } from './project-service';
import { getConfig } from './config-manager';
import { Project } from '../core/gitlab/types';
import open from 'open';

type View = 'tasks' | 'issues' | 'completed' | 'projects';
type DetailView = 'list' | 'detail';
type NotificationType = 'info' | 'success' | 'warning' | 'error';

interface Notification {
  message: string;
  type: NotificationType;
}

export const Dashboard: React.FC = () => {
  const { exit } = useApp();
  const terminalWidth = process.stdout.columns || 80;
  const terminalHeight = process.stdout.rows || 24;
  const config = getConfig().getConfig();

  // Calculate fixed layout heights
  const HEADER_HEIGHT = 1;
  const FOOTER_HEIGHT = 1;
  const CONTENT_HEIGHT = terminalHeight - HEADER_HEIGHT - FOOTER_HEIGHT;

  // Services
  const taskService = new TaskService();
  const sessionService = new SessionService();
  const issueService = new IssueService();
  const projectService = new ProjectService();

  // State
  const [currentView, setCurrentView] = useState<View>('tasks');
  const [tasks, setTasks] = useState<Task[]>([]);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [completedTasks, setCompletedTasks] = useState<Task[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [sessions, setSessions] = useState<TmuxSession[]>([]);
  const [currentProject, setCurrentProject] = useState<Project | null>(null);
  const [projectIssues, setProjectIssues] = useState<Issue[]>([]);

  // Navigation stack (browser-like history)
  const [viewStack, setViewStack] = useState<View[]>([]);

  const [selectedIndex, setSelectedIndex] = useState(0);
  const [scrollOffset, setScrollOffset] = useState(0);
  const [detailView, setDetailView] = useState<DetailView>('list');
  const [notification, setNotification] = useState<Notification | null>(null);
  const [showHelp, setShowHelp] = useState(false);

  // Multi-select mode (for Issues view)
  const [multiSelectMode, setMultiSelectMode] = useState(false);
  const [selectedIssues, setSelectedIssues] = useState<Set<number>>(new Set());

  // Animation states
  const [viewTransition, setViewTransition] = useState<'idle' | 'entering' | 'visible'>('visible');
  const [breathPhase, setBreathPhase] = useState(0);
  const [notifAnimation, setNotifAnimation] = useState<'hidden' | 'slide-in' | 'visible' | 'slide-out'>('hidden');
  const [itemAppearIndex, setItemAppearIndex] = useState(-1);
  const [loadingPulse, setLoadingPulse] = useState(0);

  // Load data on mount
  useEffect(() => {
    loadData();

    // Auto-refresh
    if (config.refreshInterval > 0) {
      const interval = setInterval(loadData, config.refreshInterval * 1000);
      return () => clearInterval(interval);
    }
  }, []);

  // Reset selected index when view changes
  useEffect(() => {
    setSelectedIndex(0);
    setScrollOffset(0);
    setDetailView('list');
    // Trigger view transition animation
    setViewTransition('entering');
    setItemAppearIndex(-1);
    const t = setTimeout(() => setViewTransition('visible'), 50);
    // Stagger list items appearance
    const items = getCurrentList();
    items.forEach((_, i) => {
      setTimeout(() => setItemAppearIndex(i), 80 + i * 30);
    });
    return () => clearTimeout(t);
  }, [currentView]);

  // Breathing border animation for selected item
  useEffect(() => {
    const interval = setInterval(() => {
      setBreathPhase(p => (p + 1) % 20);
    }, 100);
    return () => clearInterval(interval);
  }, []);

  // Loading pulse animation
  useEffect(() => {
    const loadAsync = async () => {
      try {
        switch (currentView) {
          case 'tasks':
          case 'completed': {
            const tasksData = await taskService.listTasks();
            const activeTasks = tasksData.filter(t => t.status === 'active' || t.status === 'pending');
            const completed = tasksData.filter(t => t.status === 'completed');
            setTasks(activeTasks);
            setCompletedTasks(completed);
            break;
          }
          case 'issues': {
            if (currentProject) {
              const projectIssuesData = await issueService.listIssues(currentProject.id);
              setIssues(projectIssuesData);
              setProjectIssues(projectIssuesData);
            } else {
              const issuesData = await issueService.listIssues();
              setIssues(issuesData);
            }
            break;
          }
          case 'projects': {
            const projectsData = await projectService.listProjects();
            setProjects(projectsData);
            break;
          }
        }
      } catch (error) {
        // Silently fail on auto-refresh
      }
    };
    loadAsync();
  }, [currentView, currentProject]);

  // Loading pulse when fetching
  useEffect(() => {
    const interval = setInterval(() => {
      setLoadingPulse(p => (p + 1) % 10);
    }, 80);
    return () => clearInterval(interval);
  }, []);

  // Auto-refresh when view changes - only trigger load, don't manage loading state here
  useEffect(() => {
    // Silent load on view change - the view renders immediately with current data
    // Data refresh happens in background
    const loadAsync = async () => {
      try {
        switch (currentView) {
          case 'tasks':
          case 'completed': {
            const tasksData = await taskService.listTasks();
            const activeTasks = tasksData.filter(t => t.status === 'active' || t.status === 'pending');
            const completed = tasksData.filter(t => t.status === 'completed');
            setTasks(activeTasks);
            setCompletedTasks(completed);
            break;
          }
          case 'issues': {
            if (currentProject) {
              const projectIssuesData = await issueService.listIssues(currentProject.id);
              setIssues(projectIssuesData);
              setProjectIssues(projectIssuesData);
            } else {
              const issuesData = await issueService.listIssues();
              setIssues(issuesData);
            }
            break;
          }
          case 'projects': {
            const projectsData = await projectService.listProjects();
            setProjects(projectsData);
            break;
          }
        }
      } catch (error) {
        // Silently fail on auto-refresh
      }
    };
    loadAsync();
  }, [currentView, currentProject]);

  /**
   * Update scroll offset to keep selected item visible
   */
  useEffect(() => {
    const items = getCurrentItems();
    const maxItems = Math.max(0, items.length - 1);

    // Calculate how many items fit in viewport based on fixed item heights
    // Projects/Tasks/Issues: 4 lines each, Completed: 3 lines each
    const itemHeight = currentView === 'completed' ? 3 : 4;
    const itemsPerScreen = Math.floor(CONTENT_HEIGHT / itemHeight);

    // Keep selected item in view
    if (selectedIndex < scrollOffset) {
      setScrollOffset(selectedIndex);
    } else if (selectedIndex >= scrollOffset + itemsPerScreen) {
      setScrollOffset(Math.min(selectedIndex - itemsPerScreen + 1, maxItems));
    }
  }, [selectedIndex, CONTENT_HEIGHT, currentView]);

  /**
   * Refresh current view data (unified refresh)
   * @param silent - if true, don't show notification
   */
  const refreshCurrentView = useCallback(async (silent = false) => {
    try {
      if (!silent) showNotificationMessage('正在刷新...', 'info');

      switch (currentView) {
        case 'tasks':
        case 'completed': {
          const tasksData = await taskService.listTasks();
          const activeTasks = tasksData.filter(t => t.status === 'active' || t.status === 'pending');
          const completed = tasksData.filter(t => t.status === 'completed');
          setTasks(activeTasks);
          setCompletedTasks(completed);
          break;
        }
        case 'issues': {
          if (currentProject) {
            // Refresh project issues
            const projectIssuesData = await issueService.listIssues(currentProject.id);
            setIssues(projectIssuesData);
            setProjectIssues(projectIssuesData);
          } else {
            // Refresh global issues
            const issuesData = await issueService.listIssues();
            setIssues(issuesData);
          }
          break;
        }
        case 'projects': {
          const projectsData = await projectService.listProjects();
          setProjects(projectsData);
          break;
        }
      }

      if (!silent) showNotificationMessage('刷新完成', 'success');
    } catch (error) {
      showNotificationMessage(`刷新失败: ${error}`, 'error');
    }
  }, [currentView, currentProject]);

  /**
   * Load all data (tasks and sessions)
   */
  const loadData = useCallback(async () => {
    try {
      const [tasksData, sessionsData] = await Promise.all([
        taskService.listTasks(),
        sessionService.listSessions(),
      ]);

      // Filter active tasks
      const activeTasks = tasksData.filter(t => t.status === 'active' || t.status === 'pending');
      const completed = tasksData.filter(t => t.status === 'completed');

      setTasks(activeTasks);
      setCompletedTasks(completed);
      setSessions(sessionsData);
    } catch (error) {
      showNotificationMessage('Failed to load data', 'error');
    }
  }, []);

  /**
   * Show notification with slide animation
   */
  const showNotificationMessage = (message: string, type: NotificationType) => {
    setNotifAnimation('slide-in');
    setNotification({ message, type });
    // Slide in then slide out
    setTimeout(() => setNotifAnimation('visible'), 150);
    setTimeout(() => {
      setNotifAnimation('slide-out');
      setTimeout(() => setNotifAnimation('hidden'), 150);
    }, 2700);
    setTimeout(() => setNotification(null), 3000);
  };

  /**
   * Push view to stack (browser-like navigation - go deeper)
   */
  const pushView = (view: View) => {
    // Save current view to stack before switching
    setViewStack([...viewStack, currentView]);
    setCurrentView(view);
  };

  /**
   * Pop view from stack (browser-like navigation - go back)
   */
  const popView = () => {
    if (viewStack.length === 0) return false;

    const previousView = viewStack[viewStack.length - 1];
    setViewStack(viewStack.slice(0, -1));
    setCurrentView(previousView);
    setSelectedIndex(0);
    setScrollOffset(0);
    return true;
  };

  /**
   * Check if can go back
   */
  const canGoBack = () => viewStack.length > 0;

  /**
   * Switch view - just switch, data loads automatically via useEffect
   */
  const switchView = (view: View) => {
    // Only push to stack if view is actually changing
    if (view !== currentView) {
      setViewStack([...viewStack, currentView]);
    }
    setCurrentView(view);
    // Data loading is handled by useEffect watching currentView
  };

  /**
   * Navigation handlers
   */
  const navigateDown = () => {
    const maxIndex = getCurrentList().length - 1;
    setSelectedIndex(Math.min(selectedIndex + 1, maxIndex));
  };

  const navigateUp = () => {
    setSelectedIndex(Math.max(selectedIndex - 1, 0));
  };

  const navigateTop = () => {
    setSelectedIndex(0);
  };

  const navigateBottom = () => {
    setSelectedIndex(Math.max(0, getCurrentList().length - 1));
  };

  /**
   * Get current list based on view
   */
  const getCurrentList = () => {
    switch (currentView) {
      case 'tasks':
        return tasks;
      case 'issues':
        return issues;
      case 'completed':
        return completedTasks;
      case 'projects':
        return projects;
      default:
        return [];
    }
  };

  /**
   * Get current selected item
   */
  const getCurrentItem = () => {
    const list = getCurrentList();
    return list[selectedIndex];
  };

  /**
   * Get current items list
   */
  const getCurrentItems = () => {
    return getCurrentList();
  };

  /**
   * Handle attach session (tasks view)
   */
  const handleAttachSession = async () => {
    if (currentView !== 'tasks') return;

    const task = getCurrentItem() as Task;
    if (!task?.session) {
      showNotificationMessage('该任务没有关联会话', 'warning');
      return;
    }

    try {
      // Check if session exists using node-tmux SDK
      const tmuxInstance = await createTmux();
      if (!tmuxInstance) {
        showNotificationMessage('tmux 不可用', 'error');
        return;
      }

      const sessionExists = await tmuxInstance.hasSession(task.session);
      if (!sessionExists) {
        showNotificationMessage(`会话 ${task.session} 不存在`, 'error');
        return;
      }

      // Exit Ink and attach to tmux session using native command
      exit();

      const { spawnSync, spawn } = require('child_process');

      // Attach to the tmux session
      const result = spawnSync('tmux', ['attach-session', '-t', task.session], {
        stdio: 'inherit',
      });

      // After detaching from tmux, show message and return to dashboard
      if (result.status === 0) {
        console.log('\n' + figures.tick + ' 已从会话 \x1b[36m' + task.session + '\x1b[0m 退出');
        console.log('正在返回 Dashboard...\n');

        // Small delay for user to see the message
        await new Promise(resolve => setTimeout(resolve, 1000));

        // Restart the dashboard
        const dashboardProcess = spawn(process.argv[0], process.argv.slice(1), {
          stdio: 'inherit',
        });

        dashboardProcess.on('exit', (code: number) => {
          process.exit(code || 0);
        });
      } else {
        console.error('\n' + figures.cross + ' 附加会话失败');
        process.exit(1);
      }
    } catch (error) {
      showNotificationMessage('附加会话失败', 'error');
      console.error(error);
      process.exit(1);
    }
  };

  /**
   * Handle enter project to view its issues (projects view)
   */
  const handleEnterProject = async () => {
    if (currentView !== 'projects') return;

    const project = getCurrentItem() as Project;
    if (!project) return;

    try {
      setCurrentProject(project);
      showNotificationMessage(`正在加载 ${project.name} (ID: ${project.id}) 的 Issues...`, 'info');

      const projectIssuesData = await issueService.listIssues(project.id);
      setProjectIssues(projectIssuesData);
      setIssues(projectIssuesData);
      setSelectedIndex(0);
      setScrollOffset(0);

      // Push to navigation stack and switch to issues view
      pushView('issues');

      if (projectIssuesData.length > 0) {
        showNotificationMessage(`已加载 ${project.name}: ${projectIssuesData.length} 个 Issues`, 'success');
      } else {
        showNotificationMessage(`项目 ${project.name} 没有 open issues`, 'info');
      }
    } catch (error) {
      showNotificationMessage(`加载失败: ${error}`, 'error');
    }
  };

  /**
   * Handle kill session (tasks view)
   */
  const handleKillSession = async () => {
    if (currentView !== 'tasks') return;

    const task = getCurrentItem() as Task;
    if (!task?.session) {
      showNotificationMessage('该任务没有关联会话', 'warning');
      return;
    }

    try {
      // Kill the session directly
      await sessionService.killSession(task.session);

      // Reload data from tmux
      await loadData();

      showNotificationMessage(`✓ 已终止会话: ${task.session}`, 'success');
    } catch (error) {
      showNotificationMessage(`终止会话失败: ${error}`, 'error');
    }
  };

  /**
   * Handle start from issue (issues view)
   */
  const handleStartFromIssue = async () => {
    if (currentView !== 'issues') return;

    const issue = getCurrentItem() as Issue;
    if (!issue) return;

    try {
      showNotificationMessage(`从 Issue #${issue.iid} 创建任务...`, 'info');

      // Create branch name from issue title
      const branchName = `issue-${issue.iid}-${issue.title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .substring(0, 30)}`;

      // Create tmux session name
      const sessionName = `issue-${issue.iid}`;

      // Create task from issue
      const newTask = await taskService.createTaskFromIssue(issue, {
        branch: branchName,
        session: sessionName,
        worktree: branchName,
      });

      // Reload tasks
      await loadData();

      // Switch to tasks view
      setCurrentView('tasks');
      setSelectedIndex(0);

      showNotificationMessage(
        `✓ 已创建任务 #${newTask.iid}: ${newTask.title}`,
        'success'
      );
    } catch (error) {
      showNotificationMessage('创建任务失败', 'error');
    }
  };

  /**
   * Handle open in browser (issues view)
   */
  const handleOpenInBrowser = async () => {
    if (currentView === 'issues') {
      const issue = getCurrentItem() as Issue;
      if (issue?.web_url) {
        try {
          await open(issue.web_url);
          showNotificationMessage(`已在浏览器打开 Issue #${issue.iid}`, 'success');
        } catch (error) {
          showNotificationMessage('打开浏览器失败', 'error');
        }
      }
    } else if (currentView === 'projects') {
      const project = getCurrentItem() as Project;
      if (project?.web_url) {
        try {
          await open(project.web_url);
          showNotificationMessage(`已在浏览器打开项目 ${project.name}`, 'success');
        } catch (error) {
          showNotificationMessage('打开浏览器失败', 'error');
        }
      }
    }
  };

  /**
   * Toggle multi-select mode (issues view)
   */
  const toggleMultiSelectMode = () => {
    if (currentView !== 'issues') return;

    setMultiSelectMode(!multiSelectMode);
    setSelectedIssues(new Set());
    showNotificationMessage(
      multiSelectMode ? '退出多选模式' : '进入多选模式 (Space 选择)',
      'info'
    );
  };

  /**
   * Toggle issue selection (issues view)
   */
  const toggleIssueSelection = () => {
    if (currentView !== 'issues' || !multiSelectMode) return;

    const issue = getCurrentItem() as Issue;
    if (!issue) return;

    const newSelected = new Set(selectedIssues);
    if (newSelected.has(issue.iid)) {
      newSelected.delete(issue.iid);
    } else {
      newSelected.add(issue.iid);
    }
    setSelectedIssues(newSelected);
  };

  /**
   * Batch start from selected issues
   */
  const handleBatchStart = async () => {
    if (currentView !== 'issues' || selectedIssues.size === 0) {
      showNotificationMessage('没有选中的 Issues', 'warning');
      return;
    }

    try {
      showNotificationMessage(`正在创建 ${selectedIssues.size} 个任务...`, 'info');

      let successCount = 0;
      for (const issueIid of selectedIssues) {
        const issue = issues.find(i => i.iid === issueIid);
        if (!issue) continue;

        const branchName = `issue-${issue.iid}-${issue.title
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .substring(0, 30)}`;

        await taskService.createTaskFromIssue(issue, {
          branch: branchName,
          session: `issue-${issue.iid}`,
          worktree: branchName,
        });

        successCount++;
      }

      // Reload tasks
      await loadData();

      // Clear selection and exit multi-select mode
      setSelectedIssues(new Set());
      setMultiSelectMode(false);

      // Switch to tasks view
      setCurrentView('tasks');
      setSelectedIndex(0);

      showNotificationMessage(
        `✓ 已创建 ${successCount} 个任务`,
        'success'
      );
    } catch (error) {
      showNotificationMessage('批量创建任务失败', 'error');
    }
  };

  /**
   * Clear all selections
   */
  const clearSelections = () => {
    setSelectedIssues(new Set());
    showNotificationMessage('已清空选择', 'info');
  };

  /**
   * Keyboard input handler
   */
  useInput((input, key) => {
    // Help
    if (input === '?') {
      setShowHelp(!showHelp);
      return;
    }

    // Close help/detail with ESC or 'q'
    if (key.escape || input === 'q') {
      if (showHelp) {
        setShowHelp(false);
        return;
      }
      if (detailView === 'detail') {
        setDetailView('list');
        return;
      }
      if (input === 'q' && detailView === 'list') {
        exit();
        return;
      }
    }

    // Don't handle other keys when help is open or in detail view
    if (showHelp || detailView === 'detail') return;

    // View switching
    if (input === '1') switchView('tasks');
    if (input === '2') switchView('issues');
    if (input === '3') switchView('completed');
    if (input === '4') switchView('projects');

    // Navigation - ONLY use arrow keys, remove j/k to avoid terminal scroll conflict
    if (key.downArrow) navigateDown();
    if (key.upArrow) navigateUp();
    if (input === 'g') navigateTop();
    if (key.shift && input === 'G') navigateBottom();

    // Detail - open full screen detail view
    if (key.return) {
      if (currentView === 'projects') {
        handleEnterProject();
      } else {
        setDetailView('detail');
      }
      return;
    }

    // Back to previous view (Escape) - browser-like navigation
    if (key.escape && canGoBack()) {
      popView();
      return;
    }

    // Refresh current view
    if (input === 'r') refreshCurrentView();

    // View-specific actions
    if (currentView === 'tasks') {
      if (input === 'a') handleAttachSession();
      if (input === 'k' || input === 'K') handleKillSession();
    }

    if (currentView === 'issues') {
      // Multi-select mode toggle
      if (input === 'm') {
        toggleMultiSelectMode();
        return;
      }

      // In multi-select mode
      if (multiSelectMode) {
        if (input === ' ') toggleIssueSelection();
        if (input === 'B') handleBatchStart();
        if (input === 'c') clearSelections();
        if (key.escape) {
          setMultiSelectMode(false);
          setSelectedIssues(new Set());
        }
      } else {
        // Normal mode
        if (input === 's') handleStartFromIssue();
        if (input === 'o') handleOpenInBrowser();
      }
    }

    if (currentView === 'projects') {
      if (input === 'o') handleOpenInBrowser();
    }
  });

  /**
   * Get view title
   */
  const getViewTitle = () => {
    switch (currentView) {
      case 'tasks':
        return `运行中任务 · ${tasks.length} active`;
      case 'issues':
        if (multiSelectMode) {
          return `待办 Issues · ${issues.length} opened · 已选 ${selectedIssues.size}`;
        }
        return `待办 Issues · ${issues.length} opened`;
      case 'completed':
        return `已完成 · ${completedTasks.length} completed`;
      case 'projects':
        return `GitLab 项目 · ${projects.length} projects`;
      default:
        return '';
    }
  };

  /**
   * Get bottom bar shortcuts
   */
  const getBottomBarShortcuts = () => {
    const navigation = '↑↓:导航  1-4:切换视图';
    const common = 'Enter:查看详情  r:刷新数据  q:退出';

    switch (currentView) {
      case 'tasks':
        return `${navigation}  │  a:附加会话  K:终止任务  │  ${common}`;
      case 'issues':
        if (multiSelectMode) {
          return `${navigation}  │  Space:选择  B:批量开始  c:清空选择  m:退出多选  │  ${common}`;
        }
        return `${navigation}  │  s:开始任务  o:打开浏览器  m:多选模式  │  ${common}`;
      case 'completed':
        return `${navigation}  │  ${common}`;
      case 'projects':
        return `${navigation}  │  Enter:进入  o:打开浏览器  │  ${common}`;
      default:
        return common;
    }
  };

  // Render - Q Style Cartoon Design
  return (
    <Box flexDirection="column" height={terminalHeight}>
      {detailView === 'list' ? (
        <>
          {/* Top bar - Q Style: cute header with decorations */}
          <Box height={HEADER_HEIGHT} flexShrink={0} paddingX={2} backgroundColor="black" justifyContent="space-between">
            <Text color="white">
              <Text color="magenta">☆</Text>
              <Text bold> AFK Dashboard </Text>
              <Text color="cyan">｡‿｡</Text>
              <Text color={loadingPulse < 5 ? 'white' : 'magenta'}> ◠‿◠</Text>
            </Text>
            <Text color="white">
              {currentView === 'tasks' && (
                <>
                  <Text color="green">{figures.bullet}</Text>
                  <Text> [任务] </Text>
                  <Text color="cyan">{tasks.length}</Text>
                </>
              )}
              {currentView === 'issues' && (
                <>
                  <Text color="magenta">{figures.bullet}</Text>
                  <Text> [Issues] </Text>
                  <Text color="cyan">{issues.length}</Text>
                  {multiSelectMode && (
                    <><Text dimColor> ⊙ </Text><Text color="magenta">{selectedIssues.size}选</Text></>
                  )}
                </>
              )}
              {currentView === 'completed' && (
                <>
                  <Text color="green">{figures.tick}</Text>
                  <Text> [完成] </Text>
                  <Text color="cyan">{completedTasks.length}</Text>
                </>
              )}
              {currentView === 'projects' && (
                <>
                  <Text color="cyan">{figures.star}</Text>
                  <Text> [项目] </Text>
                  <Text color="cyan">{projects.length}</Text>
                </>
              )}
            </Text>
          </Box>

          {/* Decorative separator */}
          <Box flexShrink={0}>
            <Text color="white">╭──────────────────────────────────────╮</Text>
          </Box>

          {/* Section header - cute view title */}
          <Box paddingX={2} paddingY={0}>
            <Text color="white">
              <Text color="cyan">◆ </Text>
              <Text bold>{getViewTitle()}</Text>
              <Text color="gray"> ═══</Text>
            </Text>
          </Box>

          {/* Main list - Fixed height with internal scrolling */}
          <Box height={CONTENT_HEIGHT - 2} flexShrink={0} flexDirection="column" paddingX={2} paddingY={0}>
            {currentView === 'tasks' && (
              <TaskListView
                tasks={tasks}
                selected={selectedIndex}
                scrollOffset={scrollOffset}
                viewportHeight={Math.floor((CONTENT_HEIGHT - 2) / 4)}
              />
            )}
            {currentView === 'issues' && (
              <IssueListView
                issues={issues}
                selected={selectedIndex}
                multiSelectMode={multiSelectMode}
                selectedIssues={selectedIssues}
                scrollOffset={scrollOffset}
                viewportHeight={Math.floor((CONTENT_HEIGHT - 2) / 4)}
              />
            )}
            {currentView === 'completed' && (
              <CompletedListView
                tasks={completedTasks}
                selected={selectedIndex}
                scrollOffset={scrollOffset}
                viewportHeight={Math.floor((CONTENT_HEIGHT - 2) / 3)}
              />
            )}
            {currentView === 'projects' && (
              <ProjectListView
                projects={projects}
                selected={selectedIndex}
                scrollOffset={scrollOffset}
                viewportHeight={Math.floor((CONTENT_HEIGHT - 2) / 4)}
              />
            )}
          </Box>

          {/* Bottom separator */}
          <Box flexShrink={0}>
            <Text color="white">╰──────────────────────────────────────╯</Text>
          </Box>

          {/* Bottom bar - Q style cute footer */}
          <Box height={FOOTER_HEIGHT} flexShrink={0} paddingX={1} backgroundColor="black" justifyContent="center">
            <Text>
              <Text color="cyan">↑↓</Text>
              <Text color="gray">导航</Text>
              <Text color="white"> · </Text>
              <Text color="magenta">1-4</Text>
              <Text color="gray">视图</Text>
              <Text color="white"> · </Text>
              {currentView === 'tasks' && (
                <>
                  <Text color="yellow">a</Text><Text color="gray">附</Text><Text color="white"> · </Text>
                  <Text color="yellow">K</Text><Text color="gray">杀</Text><Text color="white"> · </Text>
                </>
              )}
              {currentView === 'issues' && !multiSelectMode && (
                <>
                  <Text color="yellow">s</Text><Text color="gray">开</Text><Text color="white"> · </Text>
                  <Text color="yellow">o</Text><Text color="gray">看</Text><Text color="white"> · </Text>
                  <Text color="yellow">m</Text><Text color="gray">多选</Text><Text color="white"> · </Text>
                </>
              )}
              {currentView === 'issues' && multiSelectMode && (
                <>
                  <Text color="yellow">空格</Text><Text color="gray">选</Text><Text color="white"> · </Text>
                  <Text color="yellow">B</Text><Text color="gray">批</Text><Text color="white"> · </Text>
                </>
              )}
              {currentView === 'projects' && (
                <>
                  <Text color="yellow">Enter</Text><Text color="gray">进</Text><Text color="white"> · </Text>
                </>
              )}
              <Text color="green">Enter</Text><Text color="gray">详情</Text><Text color="white"> · </Text>
              <Text color="green">r</Text><Text color="gray">刷新</Text><Text color="white"> · </Text>
              <Text color="red">q</Text><Text color="gray">退</Text>
            </Text>
          </Box>

          {/* Notification with slide animation */}
          {notification && (
            <Box
              position="absolute"
              top={notifAnimation === 'slide-in' ? 1 : 3}
              right={notifAnimation === 'slide-in' ? -40 : 3}
              width={35}
              borderStyle="round"
              borderColor={notification.type === 'error' ? 'red' : notification.type === 'success' ? 'green' : 'cyan'}
              paddingX={1}
              backgroundColor="black"
            >
              <Text color="cyan">✧ </Text>
              <Text dimColor={notifAnimation === 'slide-out'}>{notification.message}</Text>
            </Box>
          )}

          {/* Help dialog */}
          {showHelp && <HelpDialog />}
        </>
      ) : (
        /* Full screen detail view */
        <DetailScreen
          item={getCurrentItem()}
          view={currentView}
          height={terminalHeight}
        />
      )}
    </Box>
  );
};

/**
 * Task List View Component
 */
interface TaskListViewProps {
  tasks: Task[];
  selected: number;
  scrollOffset: number;
  viewportHeight: number;
}

const TaskListView: React.FC<TaskListViewProps> = ({ tasks, selected, scrollOffset, viewportHeight }) => {
  const [breathPhase, setBreathPhase] = React.useState(0);

  React.useEffect(() => {
    const interval = setInterval(() => setBreathPhase(p => (p + 1) % 20), 100);
    return () => clearInterval(interval);
  }, []);

  if (tasks.length === 0) {
    return (
      <Box justifyContent="center" alignItems="center" height="100%">
        <Text color="gray">　　　(´･ω･`) 　暂无运行中的任务　(´･ω･`)　　　</Text>
      </Box>
    );
  }

  // Calculate visible range
  const visibleTasks = tasks.slice(scrollOffset, scrollOffset + viewportHeight);
  const startIndex = scrollOffset;

  return (
    <>
      {visibleTasks.map((task, visibleIndex) => {
        const index = startIndex + visibleIndex;
        const isSelected = index === selected;
        // Q Style: breathing border with cute colors
        const borderColor = isSelected ? (breathPhase < 10 ? 'magenta' : 'cyan') : undefined;
        const bullet = isSelected ? '◉' : (task.status === 'active' ? '●' : '○');
        const statusColor = isSelected ? 'magenta' : (task.status === 'active' ? 'green' : 'cyan');

        return (
          <Box
            key={task.iid}
            height={4}
            flexShrink={0}
            flexDirection="column"
            borderStyle={isSelected ? 'round' : undefined}
            borderColor={borderColor}
            paddingX={1}
          >
            <Box>
              <Text color={statusColor}>{bullet} </Text>
              <Text color={isSelected ? 'magenta' : 'white'} bold> #{task.iid} </Text>
              <Text color={isSelected ? 'magenta' : 'gray'} bold={isSelected}>{task.title || task.branch}</Text>
            </Box>
            <Box paddingLeft={2}>
              <Text color="gray">　♡ {task.session || '-'} │ ◈ {task.progress || '0%'} │ ⌚ {task.startedAt ? formatTime(task.startedAt) : '-'}</Text>
            </Box>
          </Box>
        );
      })}
    </>
  );
};

/**
 * Issue List View Component
 */
interface IssueListViewProps {
  issues: Issue[];
  selected: number;
  multiSelectMode?: boolean;
  selectedIssues?: Set<number>;
  scrollOffset: number;
  viewportHeight: number;
}

const IssueListView: React.FC<IssueListViewProps> = ({
  issues,
  selected,
  multiSelectMode = false,
  selectedIssues = new Set(),
  scrollOffset,
  viewportHeight
}) => {
  const [breathPhase, setBreathPhase] = React.useState(0);

  React.useEffect(() => {
    const interval = setInterval(() => setBreathPhase(p => (p + 1) % 20), 100);
    return () => clearInterval(interval);
  }, []);

  if (issues.length === 0) {
    return (
      <Box justifyContent="center" alignItems="center" height="100%">
        <Text color="gray">　　　(´∀`)･ﾟ 暂无Issues哦 　 (´∀`)･ﾟ　　　</Text>
      </Box>
    );
  }

  // Calculate visible range
  const visibleIssues = issues.slice(scrollOffset, scrollOffset + viewportHeight);
  const startIndex = scrollOffset;

  return (
    <>
      {visibleIssues.map((issue, visibleIndex) => {
        const index = startIndex + visibleIndex;
        const isSelected = selectedIssues.has(issue.iid);
        const isCurrent = index === selected;
        // Q Style cute checkbox
        const checkbox = multiSelectMode ? (isSelected ? '☑' : '☒') : '○';
        const borderColor = isCurrent ? (breathPhase < 10 ? 'magenta' : 'cyan') : undefined;

        return (
          <Box
            key={issue.iid}
            height={4}
            flexShrink={0}
            flexDirection="column"
            borderStyle={isCurrent ? 'round' : undefined}
            borderColor={borderColor}
            paddingX={1}
            backgroundColor={isSelected ? 'gray' : undefined}
          >
            <Box>
              <Text color={isCurrent ? 'magenta' : 'cyan'}>{checkbox} </Text>
              <Text color={isCurrent ? 'magenta' : 'white'} bold> #{issue.iid} </Text>
              <Text color={isCurrent ? 'magenta' : 'gray'} bold={isCurrent}>{issue.title}</Text>
            </Box>
            <Box paddingLeft={2}>
              {issue.labels.length > 0 ? (
                <Text color="gray">　★ {issue.labels.map(l => `◇${l}`).join(' ')}</Text>
              ) : (
                <Text color="gray">　★ - </Text>
              )}
              <Text color="dim">│ {issue.description ? truncate(issue.description, 40) : '...'}</Text>
            </Box>
          </Box>
        );
      })}
    </>
  );
};

/**
 * Completed List View Component
 */
interface CompletedListViewProps {
  tasks: Task[];
  selected: number;
  scrollOffset: number;
  viewportHeight: number;
}

const CompletedListView: React.FC<CompletedListViewProps> = ({ tasks, selected, scrollOffset, viewportHeight }) => {
  const [breathPhase, setBreathPhase] = React.useState(0);

  React.useEffect(() => {
    const interval = setInterval(() => setBreathPhase(p => (p + 1) % 20), 100);
    return () => clearInterval(interval);
  }, []);

  if (tasks.length === 0) {
    return (
      <Box justifyContent="center" alignItems="center" height="100%">
        <Text color="gray">　(๑˘̩˘̩˘̩˘̩)　暂无完成的任务哦～　(๑˘̩˘̩˘̩˘̩)</Text>
      </Box>
    );
  }

  // Calculate visible range
  const visibleTasks = tasks.slice(scrollOffset, scrollOffset + viewportHeight);
  const startIndex = scrollOffset;

  return (
    <>
      {visibleTasks.map((task, visibleIndex) => {
        const index = startIndex + visibleIndex;
        const isSelected = index === selected;
        // Q Style: cute completed items
        const borderColor = isSelected ? (breathPhase < 10 ? 'green' : 'cyan') : undefined;

        return (
          <Box
            key={task.iid}
            height={3}
            flexShrink={0}
            flexDirection="column"
            borderStyle={isSelected ? 'round' : undefined}
            borderColor={borderColor}
            paddingX={1}
          >
            <Box>
              <Text color="green">✓ #{task.iid}  </Text>
              <Text color={isSelected ? 'magenta' : 'gray'} bold={isSelected}>{task.title || task.branch}</Text>
              <Text color="gray">  100%  {task.startedAt ? formatTime(task.startedAt) : '-'}</Text>
            </Box>
          </Box>
        );
      })}
    </>
  );
};

/**
 * Project List View Component
 */
interface ProjectListViewProps {
  projects: Project[];
  selected: number;
  scrollOffset: number;
  viewportHeight: number;
}

const ProjectListView: React.FC<ProjectListViewProps> = ({ projects, selected, scrollOffset, viewportHeight }) => {
  const [breathPhase, setBreathPhase] = React.useState(0);

  React.useEffect(() => {
    const interval = setInterval(() => setBreathPhase(p => (p + 1) % 20), 100);
    return () => clearInterval(interval);
  }, []);

  if (projects.length === 0) {
    return (
      <Box justifyContent="center" alignItems="center" height="100%">
        <Text color="gray">　ヽ(ˇ∀ˇ )ゞ 暂无项目数据 　 ヽ(ˇ∀ˇ )ゞ</Text>
      </Box>
    );
  }

  // Calculate visible range
  const visibleProjects = projects.slice(scrollOffset, scrollOffset + viewportHeight);
  const startIndex = scrollOffset;

  return (
    <>
      {visibleProjects.map((project, visibleIndex) => {
        const index = startIndex + visibleIndex;
        const isSelected = index === selected;
        // Q Style border
        const borderColor = isSelected ? (breathPhase < 10 ? 'cyan' : 'magenta') : undefined;

        return (
          <Box
            key={project.id}
            height={4}
            flexShrink={0}
            flexDirection="column"
            borderStyle={isSelected ? 'round' : undefined}
            borderColor={borderColor}
            paddingX={1}
          >
            <Box>
              <Text color="cyan">★ </Text>
              <Text color={isSelected ? 'magenta' : 'white'} bold> #{project.id} </Text>
              <Text color={isSelected ? 'magenta' : 'gray'} bold={isSelected}>{project.name}</Text>
            </Box>
            <Box paddingLeft={2}>
              <Text color="gray">　♡ {project.path_with_namespace}</Text>
            </Box>
            <Box paddingLeft={2}>
              <Text color="dim">{project.description ? truncate(project.description, 60) : '...'}</Text>
            </Box>
          </Box>
        );
      })}
    </>
  );
};

/**
 * Detail Screen Component (Full screen, not modal)
 */
interface DetailScreenProps {
  item: Task | Issue | Project | undefined;
  view: View;
  height: number;
}

const DetailScreen: React.FC<DetailScreenProps> = ({ item, view, height }) => {
  if (!item) return <Box><Text color="gray">No item selected (´･ω･`)</Text></Box>;

  const HEADER_HEIGHT = 1;
  const FOOTER_HEIGHT = 1;
  const CONTENT_HEIGHT = height - HEADER_HEIGHT - FOOTER_HEIGHT;

  const getTitle = () => {
    if (view === 'issues') return `Issue #${(item as Issue).iid}`;
    if (view === 'projects') return `Project #${(item as Project).id}`;
    return `Task #${(item as Task).iid}`;
  };

  const getSubtitle = () => {
    if (view === 'projects') return (item as Project).name;
    return (item as any).title || (item as Task).branch;
  };

  return (
    <Box flexDirection="column" height={height}>
      {/* Top bar - Q Style cute header */}
      <Box height={HEADER_HEIGHT} flexShrink={0} paddingX={1} backgroundColor="black" justifyContent="center">
        <Text color="magenta">
          <Text bold>☆ </Text>
          <Text color="white" bold>{getTitle()}</Text>
          <Text color="gray"> │ </Text>
          <Text color="cyan">{getSubtitle()}</Text>
          <Text bold> ☆</Text>
        </Text>
      </Box>

      {/* Detail content - Q Style */}
      <Box height={CONTENT_HEIGHT} flexShrink={0} flexDirection="column" paddingX={2} paddingY={1}>
      <Text color="gray">╭────────────────────────────────────────╮</Text>

      {view === 'tasks' && (
        <Box flexDirection="column" paddingX={1}>
          <Text color="white">　◇ <Text color="cyan">状态:</Text>　<Text color="green">{(item as Task).status}</Text></Text>
          <Text color="white">　◇ <Text color="cyan">分支:</Text>　{(item as Task).branch || '-'}</Text>
          <Text color="white">　◇ <Text color="cyan">会话:</Text>　{(item as Task).session || '-'}</Text>
          <Text color="white">　◇ <Text color="cyan">进度:</Text>　{(item as Task).progress || '0%'}</Text>
          <Text color="white">　◇ <Text color="cyan">开始:</Text>　{(item as Task).startedAt ? (item as Task).startedAt?.toString() : '-'}</Text>
          <Text color="white">　◇ <Text color="cyan">工作树:</Text>　{(item as Task).worktree || '-'}</Text>
        </Box>
      )}

      {view === 'issues' && (
        <Box flexDirection="column" paddingX={1}>
          <Text color="white">　◇ <Text color="cyan">标签:</Text>　{(item as Issue).labels.map(l => `@${l}`).join(' ') || '-'}</Text>
          <Text color="white">　◇ <Text color="cyan">状态:</Text>　{(item as Issue).state}</Text>
          <Text color="white">　◇ <Text color="cyan">URL:</Text>　<Text dimColor>{(item as Issue).web_url}</Text></Text>
          <Box marginTop={1}>
            <Text color="magenta">　★ 描述:</Text>
          </Box>
          <Text color="gray">　　{(item as Issue).description || '无描述'}</Text>
        </Box>
      )}

      {view === 'projects' && (
        <Box flexDirection="column" paddingX={1}>
          <Text color="white">　◇ <Text color="cyan">路径:</Text>　{(item as Project).path_with_namespace}</Text>
          <Text color="white">　◇ <Text color="cyan">分支:</Text>　{(item as Project).default_branch}</Text>
          <Text color="white">　◇ <Text color="cyan">命名空间:</Text>　{(item as Project).namespace.name}</Text>
          <Text color="white">　◇ <Text color="cyan">更新:</Text>　{(item as Project).last_activity_at}</Text>
          <Text color="white">　◇ <Text color="cyan">URL:</Text>　<Text dimColor>{(item as Project).web_url}</Text></Text>
          <Box marginTop={1}>
            <Text color="magenta">　★ 描述:</Text>
          </Box>
          <Text color="gray">　　{(item as Project).description || '无描述'}</Text>
        </Box>
      )}

      <Text color="gray">╰────────────────────────────────────────╯</Text>
      </Box>

      {/* Bottom bar - Q Style */}
      <Box height={FOOTER_HEIGHT} flexShrink={0} paddingX={1} backgroundColor="black" justifyContent="center">
        <Text>
          <Text color="cyan">ESC/q: </Text>
          <Text color="gray">返回列表 </Text>
          <Text color="magenta">(◕‿◕)</Text>
        </Text>
      </Box>
    </Box>
  );
};

/**
 * Help Dialog Component
 */
const HelpDialog: React.FC = () => {
  return (
    <Box
      position="absolute"
      top={3}
      left={8}
      right={8}
      bottom={3}
      borderStyle="round"
      borderColor="magenta"
      backgroundColor="black"
      flexDirection="column"
      padding={1}
    >
      <Box marginBottom={1}>
        <Text bold color="magenta">☆ 快捷键帮助 ☆</Text>
      </Box>

      <Text color="cyan">视图切换:</Text>
      <Text color="white">　1 - 运行中任务　　2 - 待办 Issues</Text>
      <Text color="white">　3 - 已完成　　　　4 - GitLab项目</Text>

      <Box marginTop={1}>
        <Text color="cyan">导航:</Text>
      </Box>
      <Text color="white">　↑↓ - 上/下移动　　g/G - 首/末</Text>

      <Box marginTop={1}>
        <Text color="cyan">操作:</Text>
      </Box>
      <Text color="white">　Enter - 查看详情　ESC/q - 返回</Text>
      <Text color="white">　r - 刷新数据　　? - 帮助</Text>

      <Box marginTop={1}>
        <Text color="cyan">任务视图:</Text>
      </Box>
      <Text color="yellow">　a - 附加会话　　k - 终止会话</Text>

      <Box marginTop={1}>
        <Text color="cyan">Issues 视图:</Text>
      </Box>
      <Text color="yellow">　s - 从Issue开始工作</Text>
      <Text color="yellow">　o - 在浏览器打开　m - 多选模式</Text>

      <Box marginTop={1}>
        <Text color="cyan">项目视图:</Text>
      </Box>
      <Text color="yellow">　Enter - 进入项目Issues</Text>
      <Text color="yellow">　o - 在浏览器打开</Text>

      <Box marginTop={1} justifyContent="center">
        <Text color="gray">按 ? 或 ESC 关闭帮助 (◕‿◕)</Text>
      </Box>
    </Box>
  );
};

/**
 * Helper functions
 */
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
  return text.substring(0, maxLength - 3) + '...';
}
