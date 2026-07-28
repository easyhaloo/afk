import { useState, useEffect, useCallback, useRef } from 'react';
import { Task, Issue, Project, TmuxSession } from '../../../types/dashboard';
import type { View } from '../types';
import {
  fetchTasks,
  fetchSessions,
  fetchProjectDetail,
  fetchIssues,
  killSession,
  createTaskFromIssue,
  launchTask,
  issueService,
  projectService,
} from './fetcher';
import {
  readIssuesList, writeIssuesList,
  readProjectsList, writeProjectsList,
  readDetail, writeDetail, clearDetailCache as clearDiskDetailCache,
} from '../cache';

const PER_PAGE = 50;
/** How long to keep an in-memory project-detail response cached before refetching. */
const DETAIL_TTL_MS = 60_000;

const mergeIssues = (prev: Issue[], next: Issue[]): Issue[] => {
  const seen = new Set(prev.map(i => i.web_url));
  const merged = [...prev];
  for (const issue of next) {
    if (!seen.has(issue.web_url)) {
      merged.push(issue);
      seen.add(issue.web_url);
    }
  }
  return merged;
};

export function useData(currentView: View, currentProject: Project | null) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [completedTasks, setCompletedTasks] = useState<Task[]>([]);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [sessions, setSessions] = useState<TmuxSession[]>([]);
  const [projectBranches, setProjectBranches] = useState<any[]>([]);
  const [projectTags, setProjectTags] = useState<any[]>([]);
  const [projectCommits, setProjectCommits] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);

  // Pagination state
  const [issuePage, setIssuePage] = useState(1);
  const [issueHasMore, setIssueHasMore] = useState(false);
  const [issueProjectKey, setIssueProjectKey] = useState<string>('');
  const [projectPage, setProjectPage] = useState(1);
  const [projectHasMore, setProjectHasMore] = useState(false);

  // Mount: load tasks + sessions once
  useEffect(() => {
    (async () => {
      const [tasksData, sessionsData] = await Promise.all([
        fetchTasks(),
        fetchSessions(),
      ]);
      setTasks(tasksData.active);
      setCompletedTasks(tasksData.completed);
      setSessions(sessionsData);
    })();
  }, []);

  // View / project change: load data
  useEffect(() => {
    const projectKey = currentProject ? String(currentProject.id) : '';

    if (currentView === 'issues') {
      const isFirstPageLoad = issuePage === 1 && issues.length === 0;
      const isProjectChanged = projectKey !== issueProjectKey;
      if (isProjectChanged) {
        setIssuePage(1);
        setIssues([]);
        setIssueProjectKey(projectKey);
      }
      // Try disk cache for the first page of this project's issues regardless
      // of whether `currentProject` changed — works for both cold boot (first
      // ever visit) and return-to-scope after navigation.
      if (isFirstPageLoad || isProjectChanged) {
        const cached = readIssuesList(projectKey);
        if (cached && cached.items.length > 0) {
          setIssues(cached.items);
          setIssueHasMore(cached.hasMore);
          setIssuePage(2);
          if (isProjectChanged) return;
          // First-page cache hit on initial visit — skip network.
          if (isFirstPageLoad) return;
        }
      }
      const pageToLoad = isProjectChanged || isFirstPageLoad ? 1 : issuePage;
      (async () => {
        setLoading(true);
        try {
          const data = await fetchIssues({ projectId: currentProject?.id, page: pageToLoad, perPage: PER_PAGE });
          const nextIssues = (isProjectChanged || isFirstPageLoad) ? data.issues : mergeIssues(issues, data.issues);
          setIssues(nextIssues);
          setIssueHasMore(data.hasMore);
          if (!isProjectChanged) setIssuePage(p => p + 1);
          // Persist the cumulative issue list so the next process start is instant.
          if (nextIssues.length > 0) {
            writeIssuesList(projectKey, nextIssues, data.hasMore);
          }
        } catch (error) {
          console.error('Failed to list issues:', error);
        } finally {
          setLoading(false);
        }
      })();
    }

    if (currentView === 'projects') {
      if (projects.length === 0) {
        const cached = readProjectsList();
        if (cached && cached.items.length > 0) {
          setProjects(cached.items);
          setProjectHasMore(cached.hasMore);
          setProjectPage(2);
          // Background refresh to validate staleness — fire and forget.
          (async () => {
            try {
              const data = await projectService.listProjects(1, PER_PAGE);
              setProjects(data.projects);
              setProjectHasMore(data.hasMore);
              writeProjectsList(data.projects, data.hasMore);
            } catch { /* swallow background refresh errors */ }
          })();
          return;
        }
        (async () => {
          setLoading(true);
          try {
            const data = await projectService.listProjects(1, PER_PAGE);
            setProjects(data.projects);
            setProjectHasMore(data.hasMore);
            setProjectPage(2);
            writeProjectsList(data.projects, data.hasMore);
          } catch (error) {
            console.error('Failed to list projects:', error);
          } finally {
            setLoading(false);
          }
        })();
      }
    }
  }, [currentView, currentProject]);

  // Project detail — backed by a TTL + in-flight cache so re-entering the
  // detail screen for a project we already viewed within DETAIL_TTL_MS is
  // instant and issues zero GitLab API calls.
  const detailCacheRef = useRef<Map<number, { at: number; data: Awaited<ReturnType<typeof fetchProjectDetail>> }>>(new Map());
  const detailInFlightRef = useRef<Map<number, Promise<Awaited<ReturnType<typeof fetchProjectDetail>>>>>(new Map());

  const loadProjectDetail = useCallback(async (project: Project) => {
    // 1. In-memory cache (fastest, survives re-renders within one process)
    const memCached = detailCacheRef.current.get(project.id);
    if (memCached && Date.now() - memCached.at < DETAIL_TTL_MS) {
      setProjectBranches(memCached.data.branches);
      setProjectTags(memCached.data.tags);
      setProjectCommits(memCached.data.commits);
      return;
    }
    // 2. Disk cache (survives process restart)
    const diskCached = readDetail(project.id);
    if (diskCached) {
      setProjectBranches(diskCached.branches);
      setProjectTags(diskCached.tags);
      setProjectCommits(diskCached.commits);
      detailCacheRef.current.set(project.id, { at: Date.now(), data: {
        branches: diskCached.branches, tags: diskCached.tags, commits: diskCached.commits,
      }});
      return;
    }
    // 3. Network — share the promise across concurrent calls.
    let p = detailInFlightRef.current.get(project.id);
    if (!p) {
      p = fetchProjectDetail(project.id);
      detailInFlightRef.current.set(project.id, p);
    }
    try {
      const detail = await p;
      detailCacheRef.current.set(project.id, { at: Date.now(), data: detail });
      writeDetail(project.id, detail.branches, detail.tags, detail.commits);
      setProjectBranches(detail.branches);
      setProjectTags(detail.tags);
      setProjectCommits(detail.commits);
    } finally {
      detailInFlightRef.current.delete(project.id);
    }
  }, []);

  const reloadTasks = useCallback(async () => {
    const data = await fetchTasks();
    setTasks(data.active);
    setCompletedTasks(data.completed);
    return data;
  }, []);

  const reloadSessions = useCallback(async () => {
    const data = await fetchSessions();
    setSessions(data);
  }, []);

  const removeSession = useCallback(async (name: string) => {
    await killSession(name);
    await Promise.all([reloadSessions(), reloadTasks()]);
  }, [reloadSessions, reloadTasks]);

  const addTaskFromIssue = useCallback(async (issue: Issue, options: { branch: string; session: string; worktree: string }): Promise<Task> => {
    const task = await createTaskFromIssue(issue, options);
    await reloadTasks();
    return task;
  }, [reloadTasks]);

  /** Create a task from an issue AND launch autonomous implementation in background. */
  const launchFromIssue = useCallback(async (issue: Issue, options: { branch: string; session: string; worktree: string }): Promise<void> => {
    const task = await addTaskFromIssue(issue, options);
    if (!task.session) return;
    await launchTask(issue.iid, task.session);
  }, [addTaskFromIssue]);

  /** Launch autonomous implementation for an existing task (by session name). */
  const launchExistingTask = useCallback(async (iid: number, session: string): Promise<void> => {
    await launchTask(iid, session);
  }, []);

  /** Drop all cached project-detail responses — used by full refresh. */
  const invalidateDetailCache = useCallback(() => {
    detailCacheRef.current.clear();
    clearDiskDetailCache();
    setProjectBranches([]);
    setProjectTags([]);
    setProjectCommits([]);
  }, []);

  const fetchMoreIssues = useCallback(async () => {
    if (loading || !issueHasMore) return;
    setLoading(true);
    try {
      const data = await fetchIssues({ projectId: currentProject?.id, page: issuePage, perPage: PER_PAGE });
      let mergedItems: Issue[] = [];
      setIssues(prev => {
        mergedItems = mergeIssues(prev, data.issues);
        return mergedItems;
      });
      setIssueHasMore(data.hasMore);
      setIssuePage(p => p + 1);
      // Persist the cumulative list so a later process sees all issues
      // we've paged through.
      if (mergedItems.length > 0) {
        writeIssuesList(issueProjectKey, mergedItems, data.hasMore);
      }
    } finally {
      setLoading(false);
    }
  }, [loading, issueHasMore, issuePage, currentProject, issueProjectKey]);

  const fetchMoreProjects = useCallback(async () => {
    if (loading || !projectHasMore) return;
    setLoading(true);
    try {
      const data = await projectService.listProjects(projectPage, PER_PAGE);
      let mergedItems: Project[] = [];
      setProjects(prev => {
        mergedItems = [...prev, ...data.projects];
        return mergedItems;
      });
      setProjectHasMore(data.hasMore);
      setProjectPage(p => p + 1);
      if (mergedItems.length > 0) {
        writeProjectsList(mergedItems, data.hasMore);
      }
    } finally {
      setLoading(false);
    }
  }, [loading, projectHasMore, projectPage]);

  return {
    tasks, completedTasks, issues, projects, sessions,
    projectBranches, projectTags, projectCommits, loading,
    issueHasMore, projectHasMore,
    loadProjectDetail,
    reloadTasks, reloadSessions, removeSession, addTaskFromIssue, launchFromIssue, launchExistingTask,
    fetchMoreIssues, fetchMoreProjects,
    invalidateDetailCache,
  };
}
