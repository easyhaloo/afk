/**
 * AFK Dashboard - Single View Mode
 * Full-screen single view with quick switching
 * Hand-drawn Style Q Design (B&W only)
 */

import React, { useState, useEffect, useCallback } from 'react';
import { Box, Text, useInput, useApp } from 'ink';
import figures from 'figures';
import { tmux as createTmux } from 'node-tmux';
import { Task, TmuxSession, Issue } from '../types/dashboard';
import { TaskService } from './task-service';
import { SessionService } from './session-service';
import { IssueService } from './issue-service';
import { ProjectService, Project } from './project-service';
import { getConfig } from './config-manager';
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
  const [breathPhase, setBreathPhase] = useState(0);
  const [notifAnimation, setNotifAnimation] = useState<'hidden' | 'slide-in' | 'visible' | 'slide-out'>('hidden');
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
  }, [currentView]);

  // Breathing border animation
  useEffect(() => {
    const interval = setInterval(() => {
      setBreathPhase(p => (p + 1) % 20);
    }, 100);
    return () => clearInterval(interval);
  }, []);

  // Loading pulse
  useEffect(() => {
    const interval = setInterval(() => {
      setLoadingPulse(p => (p + 1) % 10);
    }, 80);
    return () => clearInterval(interval);
  }, []);

  // Auto-refresh when view changes
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
        // Silently fail
      }
    };
    loadAsync();
  }, [currentView, currentProject]);

  // Update scroll offset
  useEffect(() => {
    const items = getCurrentItems();
    const maxItems = Math.max(0, items.length - 1);
    const itemHeight = currentView === 'completed' ? 3 : 4;
    const itemsPerScreen = Math.floor(CONTENT_HEIGHT / itemHeight);

    if (selectedIndex < scrollOffset) {
      setScrollOffset(selectedIndex);
    } else if (selectedIndex >= scrollOffset + itemsPerScreen) {
      setScrollOffset(Math.min(selectedIndex - itemsPerScreen + 1, maxItems));
    }
  }, [selectedIndex, CONTENT_HEIGHT, currentView]);

  const refreshCurrentView = useCallback(async (silent = false) => {
    try {
      if (!silent) showNotificationMessage('refreshing...', 'info');

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

      if (!silent) showNotificationMessage('done', 'success');
    } catch (error) {
      showNotificationMessage(`error: ${error}`, 'error');
    }
  }, [currentView, currentProject]);

  const loadData = useCallback(async () => {
    try {
      const [tasksData, sessionsData] = await Promise.all([
        taskService.listTasks(),
        sessionService.listSessions(),
      ]);

      const activeTasks = tasksData.filter(t => t.status === 'active' || t.status === 'pending');
      const completed = tasksData.filter(t => t.status === 'completed');

      setTasks(activeTasks);
      setCompletedTasks(completed);
      setSessions(sessionsData);
    } catch (error) {
      showNotificationMessage('load failed', 'error');
    }
  }, []);

  const showNotificationMessage = (message: string, type: NotificationType) => {
    setNotifAnimation('slide-in');
    setNotification({ message, type });
    setTimeout(() => setNotifAnimation('visible'), 150);
    setTimeout(() => {
      setNotifAnimation('slide-out');
      setTimeout(() => setNotifAnimation('hidden'), 150);
    }, 2700);
    setTimeout(() => setNotification(null), 3000);
  };

  const pushView = (view: View) => {
    setViewStack([...viewStack, currentView]);
    setCurrentView(view);
  };

  const popView = () => {
    if (viewStack.length === 0) return false;
    const previousView = viewStack[viewStack.length - 1];
    setViewStack(viewStack.slice(0, -1));
    setCurrentView(previousView);
    setSelectedIndex(0);
    setScrollOffset(0);
    return true;
  };

  const canGoBack = () => viewStack.length > 0;

  const switchView = (view: View) => {
    if (view !== currentView) {
      setViewStack([...viewStack, currentView]);
    }
    setCurrentView(view);
  };

  const navigateDown = () => {
    const maxIndex = getCurrentList().length - 1;
    setSelectedIndex(Math.min(selectedIndex + 1, maxIndex));
  };

  const navigateUp = () => {
    setSelectedIndex(Math.max(selectedIndex - 1, 0));
  };

  const navigateTop = () => setSelectedIndex(0);

  const navigateBottom = () => {
    setSelectedIndex(Math.max(0, getCurrentList().length - 1));
  };

  const getCurrentList = () => {
    switch (currentView) {
      case 'tasks': return tasks;
      case 'issues': return issues;
      case 'completed': return completedTasks;
      case 'projects': return projects;
      default: return [];
    }
  };

  const getCurrentItem = () => getCurrentList()[selectedIndex];
  const getCurrentItems = () => getCurrentList();

  const handleAttachSession = async () => {
    if (currentView !== 'tasks') return;
    const task = getCurrentItem() as Task;
    if (!task?.session) {
      showNotificationMessage('no session', 'warning');
      return;
    }

    try {
      const tmuxInstance = await createTmux();
      if (!tmuxInstance) {
        showNotificationMessage('tmux unavailable', 'error');
        return;
      }
      const sessionExists = await tmuxInstance.hasSession(task.session);
      if (!sessionExists) {
        showNotificationMessage(`session ${task.session} not found`, 'error');
        return;
      }

      exit();
      const { spawnSync, spawn } = require('child_process');

      const result = spawnSync('tmux', ['attach-session', '-t', task.session], {
        stdio: 'inherit',
      });

      if (result.status === 0) {
        console.log('\n' + figures.tick + ' detached from \x1b[37m' + task.session + '\x1b[0m');
        console.log('returning to Dashboard...\n');
        await new Promise(resolve => setTimeout(resolve, 1000));
        const dashboardProcess = spawn(process.argv[0], process.argv.slice(1), {
          stdio: 'inherit',
        });
        dashboardProcess.on('exit', (code: number) => {
          process.exit(code || 0);
        });
      } else {
        console.error('\n' + figures.cross + ' attach failed');
        process.exit(1);
      }
    } catch (error) {
      showNotificationMessage('attach failed', 'error');
      console.error(error);
      process.exit(1);
    }
  };

  const handleEnterProject = async () => {
    if (currentView !== 'projects') return;
    const project = getCurrentItem() as Project;
    if (!project) return;

    try {
      setCurrentProject(project);
      showNotificationMessage(`loading ${project.name} issues...`, 'info');

      const projectIssuesData = await issueService.listIssues(project.id);
      setProjectIssues(projectIssuesData);
      setIssues(projectIssuesData);
      setSelectedIndex(0);
      setScrollOffset(0);

      pushView('issues');

      if (projectIssuesData.length > 0) {
        showNotificationMessage(`loaded ${project.name}: ${projectIssuesData.length} issues`, 'success');
      } else {
        showNotificationMessage(`no open issues in ${project.name}`, 'info');
      }
    } catch (error) {
      showNotificationMessage(`load failed: ${error}`, 'error');
    }
  };

  const handleKillSession = async () => {
    if (currentView !== 'tasks') return;
    const task = getCurrentItem() as Task;
    if (!task?.session) {
      showNotificationMessage('no session', 'warning');
      return;
    }

    try {
      await sessionService.killSession(task.session);
      await loadData();
      showNotificationMessage(`killed: ${task.session}`, 'success');
    } catch (error) {
      showNotificationMessage(`kill failed: ${error}`, 'error');
    }
  };

  const handleStartFromIssue = async () => {
    if (currentView !== 'issues') return;
    const issue = getCurrentItem() as Issue;
    if (!issue) return;

    try {
      showNotificationMessage(`creating task from #${issue.iid}...`, 'info');

      const branchName = `issue-${issue.iid}-${issue.title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .substring(0, 30)}`;

      const sessionName = `issue-${issue.iid}`;

      const newTask = await taskService.createTaskFromIssue(issue, {
        branch: branchName,
        session: sessionName,
        worktree: branchName,
      });

      await loadData();
      setCurrentView('tasks');
      setSelectedIndex(0);

      showNotificationMessage(`created task #${newTask.iid}: ${newTask.title}`, 'success');
    } catch (error) {
      showNotificationMessage('create failed', 'error');
    }
  };

  const handleOpenInBrowser = async () => {
    if (currentView === 'issues') {
      const issue = getCurrentItem() as Issue;
      if (issue?.web_url) {
        try {
          await open(issue.web_url);
          showNotificationMessage(`opened #${issue.iid}`, 'success');
        } catch (error) {
          showNotificationMessage('open failed', 'error');
        }
      }
    } else if (currentView === 'projects') {
      const project = getCurrentItem() as Project;
      if (project?.web_url) {
        try {
          await open(project.web_url);
          showNotificationMessage(`opened ${project.name}`, 'success');
        } catch (error) {
          showNotificationMessage('open failed', 'error');
        }
      }
    }
  };

  const toggleMultiSelectMode = () => {
    if (currentView !== 'issues') return;
    setMultiSelectMode(!multiSelectMode);
    setSelectedIssues(new Set());
    showNotificationMessage(
      multiSelectMode ? 'exit multi-select' : 'enter multi-select (Space to select)',
      'info'
    );
  };

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

  const handleBatchStart = async () => {
    if (currentView !== 'issues' || selectedIssues.size === 0) {
      showNotificationMessage('no issues selected', 'warning');
      return;
    }

    try {
      showNotificationMessage(`creating ${selectedIssues.size} tasks...`, 'info');

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

      await loadData();
      setSelectedIssues(new Set());
      setMultiSelectMode(false);
      setCurrentView('tasks');
      setSelectedIndex(0);

      showNotificationMessage(`created ${successCount} tasks`, 'success');
    } catch (error) {
      showNotificationMessage('batch create failed', 'error');
    }
  };

  const clearSelections = () => {
    setSelectedIssues(new Set());
    showNotificationMessage('cleared', 'info');
  };

  useInput((input, key) => {
    if (input === '?') {
      setShowHelp(!showHelp);
      return;
    }

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

    if (showHelp || detailView === 'detail') return;

    if (input === '1') switchView('tasks');
    if (input === '2') switchView('issues');
    if (input === '3') switchView('completed');
    if (input === '4') switchView('projects');

    if (key.downArrow) navigateDown();
    if (key.upArrow) navigateUp();
    if (input === 'g') navigateTop();
    if (key.shift && input === 'G') navigateBottom();

    if (key.return) {
      if (currentView === 'projects') {
        handleEnterProject();
      } else {
        setDetailView('detail');
      }
      return;
    }

    if (key.escape && canGoBack()) {
      popView();
      return;
    }

    if (input === 'r') refreshCurrentView();

    if (currentView === 'tasks') {
      if (input === 'a') handleAttachSession();
      if (input === 'k' || input === 'K') handleKillSession();
    }

    if (currentView === 'issues') {
      if (input === 'm') {
        toggleMultiSelectMode();
        return;
      }

      if (multiSelectMode) {
        if (input === ' ') toggleIssueSelection();
        if (input === 'B') handleBatchStart();
        if (input === 'c') clearSelections();
        if (key.escape) {
          setMultiSelectMode(false);
          setSelectedIssues(new Set());
        }
      } else {
        if (input === 's') handleStartFromIssue();
        if (input === 'o') handleOpenInBrowser();
      }
    }

    if (currentView === 'projects') {
      if (input === 'o') handleOpenInBrowser();
    }
  });

  const getViewTitle = () => {
    switch (currentView) {
      case 'tasks':
        return `tasks running: ${tasks.length}`;
      case 'issues':
        if (multiSelectMode) {
          return `issues todo: ${issues.length} | selected: ${selectedIssues.size}`;
        }
        return `issues todo: ${issues.length}`;
      case 'completed':
        return `completed: ${completedTasks.length}`;
      case 'projects':
        return `gitlab projects: ${projects.length}`;
      default:
        return '';
    }
  };

  // Render - Hand-drawn Style Q Design (B&W only)
  return (
    <Box flexDirection="column" height={terminalHeight}>
      {detailView === 'list' ? (
        <>
          {/* Top bar - Hand-drawn style header */}
          <Box height={HEADER_HEIGHT} flexShrink={0} paddingX={2} backgroundColor="black" justifyContent="space-between">
            <Text color="white">
              <Text>*</Text>
              <Text bold> AFK Dashboard </Text>
              <Text color="gray">(^_^)</Text>
            </Text>
            <Text color="white">
              {currentView === 'tasks' && (
                <>
                  <Text>[*] </Text>
                  <Text>tasks </Text>
                  <Text>{tasks.length}</Text>
                </>
              )}
              {currentView === 'issues' && (
                <>
                  <Text>[~] </Text>
                  <Text>issues </Text>
                  <Text>{issues.length}</Text>
                  {multiSelectMode && (
                    <><Text dimColor> (</Text><Text>{selectedIssues.size}</Text><Text dimColor>)</Text></>
                  )}
                </>
              )}
              {currentView === 'completed' && (
                <>
                  <Text>[v] </Text>
                  <Text>done </Text>
                  <Text>{completedTasks.length}</Text>
                </>
              )}
              {currentView === 'projects' && (
                <>
                  <Text>[^] </Text>
                  <Text>projects </Text>
                  <Text>{projects.length}</Text>
                </>
              )}
            </Text>
          </Box>

          {/* Hand-drawn style separator */}
          <Box flexShrink={0}>
            <Text color="gray">.-~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~-.</Text>
          </Box>

          {/* Section header */}
          <Box paddingX={2} paddingY={0}>
            <Text color="white">
              <Text>(</Text>
              <Text bold>{getViewTitle()}</Text>
              <Text>) </Text>
              <Text color="gray">~-~-</Text>
            </Text>
          </Box>

          {/* Main list */}
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
            <Text color="gray">`~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~'</Text>
          </Box>

          {/* Bottom bar - Hand-drawn style footer */}
          <Box height={FOOTER_HEIGHT} flexShrink={0} paddingX={1} backgroundColor="black" justifyContent="center">
            <Text>
              <Text color="white">~</Text>
              <Text color="gray">up/dn</Text>
              <Text color="white">~</Text>
              <Text color="gray"> | </Text>
              <Text color="white">1-4</Text>
              <Text color="gray">view</Text>
              <Text color="white"> | </Text>
              {currentView === 'tasks' && (
                <>
                  <Text color="white">a</Text><Text color="gray">attach</Text><Text color="white"> | </Text>
                  <Text color="white">K</Text><Text color="gray">kill</Text><Text color="white"> | </Text>
                </>
              )}
              {currentView === 'issues' && !multiSelectMode && (
                <>
                  <Text color="white">s</Text><Text color="gray">start</Text><Text color="white"> | </Text>
                  <Text color="white">o</Text><Text color="gray">open</Text><Text color="white"> | </Text>
                  <Text color="white">m</Text><Text color="gray">multi</Text><Text color="white"> | </Text>
                </>
              )}
              {currentView === 'issues' && multiSelectMode && (
                <>
                  <Text color="white">Space</Text><Text color="gray">select</Text><Text color="white"> | </Text>
                  <Text color="white">B</Text><Text color="gray">batch</Text><Text color="white"> | </Text>
                </>
              )}
              {currentView === 'projects' && (
                <>
                  <Text color="white">Enter</Text><Text color="gray">enter</Text><Text color="white"> | </Text>
                </>
              )}
              <Text color="white">Enter</Text><Text color="gray">detail</Text><Text color="white"> | </Text>
              <Text color="white">r</Text><Text color="gray">refresh</Text><Text color="white"> | </Text>
              <Text color="white">q</Text><Text color="gray">quit</Text>
              <Text color="white">~</Text>
            </Text>
          </Box>

          {/* Notification */}
          {notification && (
            <Box
              position="absolute"
              top={notifAnimation === 'slide-in' ? 1 : 3}
              right={notifAnimation === 'slide-in' ? -40 : 3}
              width={35}
              borderStyle="round"
              borderColor="white"
              paddingX={1}
              backgroundColor="black"
            >
              <Text color="white">* </Text>
              <Text dimColor={notifAnimation === 'slide-out'}>{notification.message}</Text>
            </Box>
          )}

          {/* Help dialog */}
          {showHelp && <HelpDialog />}
        </>
      ) : (
        <DetailScreen
          item={getCurrentItem()}
          view={currentView}
          height={terminalHeight}
        />
      )}
    </Box>
  );
};

/* ============ List View Components ============ */

const TaskListView: React.FC<{tasks: Task[]; selected: number; scrollOffset: number; viewportHeight: number}> = ({ tasks, selected, scrollOffset, viewportHeight }) => {
  const [breathPhase, setBreathPhase] = React.useState(0);

  React.useEffect(() => {
    const interval = setInterval(() => setBreathPhase(p => (p + 1) % 20), 100);
    return () => clearInterval(interval);
  }, []);

  if (tasks.length === 0) {
    return (
      <Box justifyContent="center" alignItems="center" height="100%">
        <Text color="gray">    ( o_o )  no running tasks  ( o_o )</Text>
      </Box>
    );
  }

  const visibleTasks = tasks.slice(scrollOffset, scrollOffset + viewportHeight);
  const startIndex = scrollOffset;

  return (
    <>
      {visibleTasks.map((task, visibleIndex) => {
        const index = startIndex + visibleIndex;
        const isSelected = index === selected;
        const borderColor = isSelected ? (breathPhase < 10 ? 'white' : 'gray') : undefined;
        const bullet = isSelected ? '(*)' : (task.status === 'active' ? '(.)' : '(-)');
        const textColor = isSelected ? 'white' : 'gray';

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
              <Text color="white">{bullet} </Text>
              <Text color={textColor} bold> #{task.iid} </Text>
              <Text color={textColor}>{task.title || task.branch}</Text>
            </Box>
            <Box paddingLeft={2}>
              <Text dimColor>    ~ {task.session || '-'} | {task.progress || '0%'} | {task.startedAt ? formatTime(task.startedAt) : '-'}</Text>
            </Box>
          </Box>
        );
      })}
    </>
  );
};

const IssueListView: React.FC<{issues: Issue[]; selected: number; multiSelectMode?: boolean; selectedIssues?: Set<number>; scrollOffset: number; viewportHeight: number}> = ({ issues, selected, multiSelectMode = false, selectedIssues = new Set(), scrollOffset, viewportHeight }) => {
  const [breathPhase, setBreathPhase] = React.useState(0);

  React.useEffect(() => {
    const interval = setInterval(() => setBreathPhase(p => (p + 1) % 20), 100);
    return () => clearInterval(interval);
  }, []);

  if (issues.length === 0) {
    return (
      <Box justifyContent="center" alignItems="center" height="100%">
        <Text color="gray">    ( o_o )  no issues  ( o_o )</Text>
      </Box>
    );
  }

  const visibleIssues = issues.slice(scrollOffset, scrollOffset + viewportHeight);
  const startIndex = scrollOffset;

  return (
    <>
      {visibleIssues.map((issue, visibleIndex) => {
        const index = startIndex + visibleIndex;
        const isSelected = selectedIssues.has(issue.iid);
        const isCurrent = index === selected;
        const checkbox = multiSelectMode ? (isSelected ? '[x]' : '[ ]') : '( )';
        const borderColor = isCurrent ? (breathPhase < 10 ? 'white' : 'gray') : undefined;
        const textColor = isCurrent ? 'white' : 'gray';

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
              <Text color={textColor}>{checkbox} </Text>
              <Text color={textColor} bold> #{issue.iid} </Text>
              <Text color={textColor}>{issue.title}</Text>
            </Box>
            <Box paddingLeft={2}>
              <Text dimColor>    # {issue.labels.length > 0 ? issue.labels.join(', ') : '-'}</Text>
              <Text dimColor> - {issue.description ? truncate(issue.description, 40) : '...'}</Text>
            </Box>
          </Box>
        );
      })}
    </>
  );
};

const CompletedListView: React.FC<{tasks: Task[]; selected: number; scrollOffset: number; viewportHeight: number}> = ({ tasks, selected, scrollOffset, viewportHeight }) => {
  const [breathPhase, setBreathPhase] = React.useState(0);

  React.useEffect(() => {
    const interval = setInterval(() => setBreathPhase(p => (p + 1) % 20), 100);
    return () => clearInterval(interval);
  }, []);

  if (tasks.length === 0) {
    return (
      <Box justifyContent="center" alignItems="center" height="100%">
        <Text color="gray">    ( o_o )  no completed tasks  ( o_o )</Text>
      </Box>
    );
  }

  const visibleTasks = tasks.slice(scrollOffset, scrollOffset + viewportHeight);
  const startIndex = scrollOffset;

  return (
    <>
      {visibleTasks.map((task, visibleIndex) => {
        const index = startIndex + visibleIndex;
        const isSelected = index === selected;
        const borderColor = isSelected ? (breathPhase < 10 ? 'white' : 'gray') : undefined;
        const textColor = isSelected ? 'white' : 'gray';

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
              <Text color="white">[v] </Text>
              <Text color={textColor} bold> #{task.iid} </Text>
              <Text color={textColor}>{task.title || task.branch}</Text>
              <Text dimColor>  100%  {task.startedAt ? formatTime(task.startedAt) : '-'}</Text>
            </Box>
          </Box>
        );
      })}
    </>
  );
};

const ProjectListView: React.FC<{projects: Project[]; selected: number; scrollOffset: number; viewportHeight: number}> = ({ projects, selected, scrollOffset, viewportHeight }) => {
  const [breathPhase, setBreathPhase] = React.useState(0);

  React.useEffect(() => {
    const interval = setInterval(() => setBreathPhase(p => (p + 1) % 20), 100);
    return () => clearInterval(interval);
  }, []);

  if (projects.length === 0) {
    return (
      <Box justifyContent="center" alignItems="center" height="100%">
        <Text color="gray">    ( o_o )  no projects  ( o_o )</Text>
      </Box>
    );
  }

  const visibleProjects = projects.slice(scrollOffset, scrollOffset + viewportHeight);
  const startIndex = scrollOffset;

  return (
    <>
      {visibleProjects.map((project, visibleIndex) => {
        const index = startIndex + visibleIndex;
        const isSelected = index === selected;
        const borderColor = isSelected ? (breathPhase < 10 ? 'white' : 'gray') : undefined;
        const textColor = isSelected ? 'white' : 'gray';

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
              <Text color="white">[^] </Text>
              <Text color={textColor} bold> #{project.id} </Text>
              <Text color={textColor}>{project.name}</Text>
            </Box>
            <Box paddingLeft={2}>
              <Text dimColor>    ~ {project.path_with_namespace}</Text>
            </Box>
            <Box paddingLeft={2}>
              <Text dimColor>    ~ {project.description ? truncate(project.description, 60) : '...'}</Text>
            </Box>
          </Box>
        );
      })}
    </>
  );
};

/* ============ Detail & Help Components ============ */

const DetailScreen: React.FC<{item: Task | Issue | Project | undefined; view: View; height: number}> = ({ item, view, height }) => {
  if (!item) return <Box><Text color="gray">( o_o ) no item selected</Text></Box>;

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

  return (
    <Box flexDirection="column" height={height}>
      {/* Top bar */}
      <Box height={HEADER_HEIGHT} flexShrink={0} paddingX={1} backgroundColor="black" justifyContent="center">
        <Text color="white">
          <Text bold>* </Text>
          <Text>{getTitle()}</Text>
          <Text color="gray"> | </Text>
          <Text>{getSubtitle()}</Text>
          <Text> *</Text>
        </Text>
      </Box>

      {/* Content */}
      <Box height={CONTENT_HEIGHT} flexShrink={0} flexDirection="column" paddingX={2} paddingY={1}>
        <Text color="gray">.-~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~-.</Text>

        {view === 'tasks' && (
          <Box flexDirection="column" paddingX={1}>
            <Text color="white">  - status: {(item as Task).status}</Text>
            <Text color="white">  - branch: {(item as Task).branch || '-'}</Text>
            <Text color="white">  - session: {(item as Task).session || '-'}</Text>
            <Text color="white">  - progress: {(item as Task).progress || '0%'}</Text>
            <Text color="white">  - started: {(item as Task).startedAt ? (item as Task).startedAt?.toString() : '-'}</Text>
            <Text color="white">  - worktree: {(item as Task).worktree || '-'}</Text>
          </Box>
        )}

        {view === 'issues' && (
          <Box flexDirection="column" paddingX={1}>
            <Text color="white">  - labels: {(item as Issue).labels.join(', ') || '-'}</Text>
            <Text color="white">  - state: {(item as Issue).state}</Text>
            <Text color="white">  - url: {(item as Issue).web_url}</Text>
            <Box marginTop={1}>
              <Text color="gray">  - description:</Text>
            </Box>
            <Text color="gray">    {(item as Issue).description || 'no description'}</Text>
          </Box>
        )}

        {view === 'projects' && (
          <Box flexDirection="column" paddingX={1}>
            <Text color="white">  - path: {(item as Project).path_with_namespace}</Text>
            <Text color="white">  - branch: {(item as Project).default_branch}</Text>
            <Text color="white">  - namespace: {(item as Project).namespace.name}</Text>
            <Text color="white">  - updated: {(item as Project).last_activity_at}</Text>
            <Box marginTop={1}>
              <Text color="gray">  - description:</Text>
            </Box>
            <Text color="gray">    {(item as Project).description || 'no description'}</Text>
          </Box>
        )}

        <Text color="gray">`~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~'</Text>
      </Box>

      {/* Bottom bar */}
      <Box height={FOOTER_HEIGHT} flexShrink={0} paddingX={1} backgroundColor="black" justifyContent="center">
        <Text>
          <Text color="gray">ESC/q: back </Text>
          <Text>( o_o )</Text>
        </Text>
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
        <Text bold color="white">* Help *</Text>
      </Box>

      <Text color="gray">view switch:</Text>
      <Text color="white">  1 - tasks     2 - issues</Text>
      <Text color="white">  3 - done     4 - projects</Text>

      <Box marginTop={1}>
        <Text color="gray">navigate:</Text>
      </Box>
      <Text color="white">  up/down - move</Text>
      <Text color="white">  g/G - top/bottom</Text>

      <Box marginTop={1}>
        <Text color="gray">actions:</Text>
      </Box>
      <Text color="white">  Enter - detail</Text>
      <Text color="white">  r - refresh</Text>
      <Text color="white">  q - quit</Text>

      <Box marginTop={1}>
        <Text color="gray">tasks:</Text>
      </Box>
      <Text color="white">  a - attach   k - kill</Text>

      <Box marginTop={1}>
        <Text color="gray">issues:</Text>
      </Box>
      <Text color="white">  s - start    o - open</Text>
      <Text color="white">  m - multi select</Text>

      <Box marginTop={1}>
        <Text color="gray">projects:</Text>
      </Box>
      <Text color="white">  Enter - enter issues</Text>
      <Text color="white">  o - open</Text>

      <Box marginTop={1} justifyContent="center">
        <Text color="gray">? or ESC to close ( o_o )</Text>
      </Box>
    </Box>
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
  return text.substring(0, maxLength - 3) + '...';
}
