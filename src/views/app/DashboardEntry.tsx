/**
 * DashboardEntry - Entry point that connects App with data layer
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Box } from 'ink';
import { AppContent } from './AppContent';
import { initRegistry } from '../board/registry/init';
import { Task, Issue, Project, TmuxSession } from '../../types/board';
import { StateProvider } from './state/StateContext';
import { TmuxClient } from '../../lib/core/tmux/tmux';
import { useLoadingPhases } from '../board/hooks/useLoadingPhase';
import { SplashScreen } from '../board/components/SplashScreen';
import {
  fetchTasks, fetchSessions, fetchIssues, fetchProjects,
  killSession, createTaskFromIssue, launchTask, fetchProjectDetail,
} from '../board/data/fetcher';
import {
  readIssuesList, writeIssuesList,
  readProjectsList, writeProjectsList,
  readDetail, writeDetail, clearDetailCache as clearDiskDetailCache,
} from '../board/cache';

// Initialize registry
initRegistry();

const PER_PAGE = 50;

export function DashboardEntry() {
  const { phases, isReady } = useLoadingPhases();
  const [showApp, setShowApp] = useState(false);
  const [appReady, setAppReady] = useState(false);

  // After splash signals showApp, wait for fade-out then signal appReady
  useEffect(() => {
    if (showApp) {
      // Splash fade-out takes ~500ms, give a bit extra
      const timer = setTimeout(() => setAppReady(true), 600);
      return () => clearTimeout(timer);
    }
    setAppReady(false);
  }, [showApp]);

  // Once isReady, show app and never go back
  React.useEffect(() => {
    if (isReady) {
      setShowApp(true);
    }
  }, [isReady]);

  // Loaded data
  const [tasks, setTasks] = useState<Task[]>([]);
  const [sessions, setSessions] = useState<TmuxSession[]>([]);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [issueProject, setIssueProject] = useState<Project | null>(null);
  const [currentView, setCurrentView] = useState<string>('tasks');

  // Load real data once ready
  useEffect(() => {
    if (!isReady) return;
    (async () => {
      const [tasksData, sessionsData] = await Promise.all([
        fetchTasks(),
        fetchSessions(),
      ]);
      setTasks(tasksData.active);
      setSessions(sessionsData);
    })();
  }, [isReady]);

  // Issue/Project pagination
  const [issuePage, setIssuePage] = useState(1);
  const [issueHasMore, setIssueHasMore] = useState(false);
  const [projectPage, setProjectPage] = useState(1);
  const [projectHasMore, setProjectHasMore] = useState(false);

  // Detail cache
  const detailCacheRef = React.useRef<Map<number, { at: number; data: any }>>(new Map());
  const [projectBranches, setProjectBranches] = useState<any[]>([]);
  const [projectTags, setProjectTags] = useState<any[]>([]);
  const [projectCommits, setProjectCommits] = useState<any[]>([]);

  // Load issues when view changes
  useEffect(() => {
    if (!isReady || currentView !== 'issues') return;
    const projectKey = issueProject ? String(issueProject.id) : '';
    const cached = readIssuesList(projectKey);
    if (cached && cached.items.length > 0) {
      setIssues(cached.items);
      setIssueHasMore(cached.hasMore);
      setIssuePage(2);
      return;
    }
    (async () => {
      const data = await fetchIssues({ projectId: issueProject?.id, page: 1, perPage: PER_PAGE });
      setIssues(data.issues);
      setIssueHasMore(data.hasMore);
      setIssuePage(2);
      if (data.issues.length > 0) writeIssuesList(projectKey, data.issues, data.hasMore);
    })();
  }, [isReady, currentView, issueProject]);

  // Load projects when view changes
  useEffect(() => {
    if (!isReady || currentView !== 'projects') return;
    const cached = readProjectsList();
    if (cached && cached.items.length > 0) {
      setProjects(cached.items);
      setProjectHasMore(cached.hasMore);
      setProjectPage(2);
      return;
    }
    (async () => {
      const data = await fetchProjects({ page: 1, perPage: PER_PAGE });
      setProjects(data.projects);
      setProjectHasMore(data.hasMore);
      setProjectPage(2);
      writeProjectsList(data.projects, data.hasMore);
    })();
  }, [isReady, currentView]);

  const loadProjectDetail = useCallback(async (project: Project) => {
    const memCached = detailCacheRef.current.get(project.id);
    if (memCached && Date.now() - memCached.at < 60_000) {
      setProjectBranches(memCached.data.branches);
      setProjectTags(memCached.data.tags);
      setProjectCommits(memCached.data.commits);
      return;
    }
    const diskCached = readDetail(project.id);
    if (diskCached) {
      setProjectBranches(diskCached.branches);
      setProjectTags(diskCached.tags);
      setProjectCommits(diskCached.commits);
      detailCacheRef.current.set(project.id, { at: Date.now(), data: diskCached });
      return;
    }
    const detail = await fetchProjectDetail(project.id);
    detailCacheRef.current.set(project.id, { at: Date.now(), data: detail });
    writeDetail(project.id, detail.branches, detail.tags, detail.commits);
    setProjectBranches(detail.branches);
    setProjectTags(detail.tags);
    setProjectCommits(detail.commits);
  }, []);

  const reloadTasks = useCallback(async () => {
    const data = await fetchTasks();
    setTasks(data.active);
  }, []);

  const removeSession = useCallback(async (name: string) => {
    await killSession(name);
    const [tasksData, sessionsData] = await Promise.all([fetchTasks(), fetchSessions()]);
    setTasks(tasksData.active);
    setSessions(sessionsData);
  }, []);

  const addTaskFromIssue = useCallback(async (issue: Issue, options: any) => {
    const task = await createTaskFromIssue(issue, options);
    await reloadTasks();
    return task;
  }, [reloadTasks]);

  const launchFromIssue = useCallback(async (issue: Issue, options: any) => {
    const task = await addTaskFromIssue(issue, options);
    if (!task.session) return;
    await launchTask(issue.iid, task.session);
  }, [addTaskFromIssue]);

  const launchExistingTask = useCallback(async (iid: number, session: string) => {
    await launchTask(iid, session);
  }, []);

  const fetchMoreIssues = useCallback(async () => {
    if (!issueHasMore) return;
    const data = await fetchIssues({ projectId: issueProject?.id, page: issuePage, perPage: PER_PAGE });
    setIssues(prev => [...prev, ...data.issues]);
    setIssueHasMore(data.hasMore);
    setIssuePage(p => p + 1);
  }, [issueHasMore, issuePage, issueProject]);

  const fetchMoreProjects = useCallback(async () => {
    if (!projectHasMore) return;
    const data = await fetchProjects({ page: projectPage, perPage: PER_PAGE });
    setProjects(prev => [...prev, ...data.projects]);
    setProjectHasMore(data.hasMore);
    setProjectPage(p => p + 1);
  }, [projectHasMore, projectPage]);

  const invalidateDetailCache = useCallback(() => {
    detailCacheRef.current.clear();
    clearDiskDetailCache();
    setProjectBranches([]);
    setProjectTags([]);
    setProjectCommits([]);
  }, []);

  const handleAttachSession = useCallback(async (task: Task) => {
    const sessionName = task?.session
      || (task?.platform === 'github' ? `afk-gh-${task.iid}` : null)
      || (task?.platform === 'gitlab' ? `afk-gl-${task.iid}` : null)
      || (task?.iid ? `afk-gl-${task.iid}` : null);
    if (!sessionName) return;
    try {
      const tmux = new TmuxClient();
      await tmux.attach(sessionName);
    } catch {}
  }, []);

  if (!showApp) {
    return <SplashScreen phases={phases} onComplete={() => setShowApp(true)} />;
  }

  return (
    <Box flexDirection="column">
      <StateProvider>
      <AppContent
        tasks={tasks}
        issues={issues}
        projects={projects}
        sessions={sessions}
        projectBranches={projectBranches}
        projectTags={projectTags}
        projectCommits={projectCommits}
        issueHasMore={issueHasMore}
        projectHasMore={projectHasMore}
        onLoadProjectDetail={loadProjectDetail}
        onReloadTasks={reloadTasks}
        onRemoveSession={removeSession}
        onAddTaskFromIssue={addTaskFromIssue}
        onLaunchFromIssue={launchFromIssue}
        onLaunchExistingTask={launchExistingTask}
        onFetchMoreIssues={fetchMoreIssues}
        onFetchMoreProjects={fetchMoreProjects}
        onInvalidateDetailCache={invalidateDetailCache}
        onAttachSession={handleAttachSession}
      />
      </StateProvider>
    </Box>
  );
}
