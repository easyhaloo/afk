import { useState, useEffect, useCallback, useRef } from 'react';
import { Task, Issue, TmuxSession } from '../../../types/board';
import type { View } from '../types';
import type { Project, Branch, Tag, Commit } from '../../../lib/core/tracker/types';
import { fileLogger } from '../../../lib/io';
import {
  fetchTasks,
  fetchSessions,
  fetchProjectDetail,
  fetchIssues,
  fetchProjects,
  killSession,
  createTaskFromIssue,
  launchTask,
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

  // Track previous project for change detection
  const prevProjectRef = useRef<number | null>(null);

  // Mount: load tasks + sessions once
  useEffect(() => {
    (async () => {
      const [tasksData, sessionsData] = await Promise.all([
        fetchTasks(),
        fetchSessions(),
      ]);
      setTasks(tasksData.active);
      setSessions(sessionsData);
    })();
  }, []);

  // View / project change: load data
  useEffect(() => {
    fileLogger.info({ currentView, projectsLen: projects.length, currentProjectId: currentProject?.id }, 'useData view effect');
    const projectKey = currentProject ? String(currentProject.id) : 'all';

    if (currentView === 'issues') {
      const isProjectChanged = prevProjectRef.current !== (currentProject?.id ?? null);
      const isFirstPageLoad = issuePage === 1 && issues.length === 0;

      // If project changed, reset pagination and clear issues
      if (isProjectChanged) {
        setIssuePage(1);
        setIssues([]);
        setIssueHasMore(false);
        setIssueProjectKey(projectKey);
        prevProjectRef.current = currentProject?.id ?? null;
      }

      // Try disk cache first for initial load
      if (isFirstPageLoad || isProjectChanged) {
        const cached = readIssuesList(projectKey);
        if (cached && cached.items.length > 0) {
          setIssues(cached.items);
          setIssueHasMore(cached.hasMore);
          setIssuePage(2);
          // Background refresh
          (async () => {
            try {
              const data = await fetchIssues({ projectId: currentProject?.id ?? null, page: 1, perPage: PER_PAGE });
              setIssues(data.issues);
              setIssueHasMore(data.hasMore);
              if (data.issues.length > 0) {
                writeIssuesList(projectKey, data.issues, data.hasMore);
              }
            } catch { /* swallow background refresh errors */ }
          })();
          return;
        }
      }

      // Fetch from network
      const pageToLoad = isProjectChanged ? 1 : issuePage;
      (async () => {
        setLoading(true);
        try {
          const data = await fetchIssues({ projectId: currentProject?.id ?? null, page: pageToLoad, perPage: PER_PAGE });
          const nextIssues = isProjectChanged ? data.issues : mergeIssues(issues, data.issues);
          setIssues(nextIssues);
          setIssueHasMore(data.hasMore);
          if (!isProjectChanged) setIssuePage(p => p + 1);
          else setIssuePage(2);
          // Persist cache
          if (nextIssues.length > 0) {
            writeIssuesList(projectKey, nextIssues, data.hasMore);
          }
        } catch (error) {
          fileLogger.error({ err: String(error) }, 'failed to list issues');
        } finally {
          setLoading(false);
        }
      })();
    }

    if (currentView === 'projects') {
      fileLogger.info({ projectsLen: projects.length, hasMore: projectHasMore }, 'projects view active');
      if (projects.length === 0) {
        const cached = readProjectsList();
        if (cached && cached.items.length > 0) {
          fileLogger.info({ cachedLen: cached.items.length }, 'using cached projects');
          setProjects(cached.items);
          setProjectHasMore(cached.hasMore);
          setProjectPage(2);
          // Background refresh to validate staleness
          (async () => {
            try {
              const data = await fetchProjects();
              setProjects(data.projects);
              setProjectHasMore(data.hasMore);
              writeProjectsList(data.projects, data.hasMore);
            } catch { /* swallow background refresh errors */ }
          })();
          return;
        }
        fileLogger.info('no cache, fetching from network');
        (async () => {
          setLoading(true);
          try {
            const data = await fetchProjects();
            fileLogger.info({ fetchedLen: data.projects.length }, 'fetchProjects result');
            setProjects(data.projects);
            setProjectHasMore(data.hasMore);
            setProjectPage(2);
            writeProjectsList(data.projects, data.hasMore);
          } catch (error) {
            fileLogger.error({ err: String(error) }, 'failed to list projects');
          } finally {
            setLoading(false);
          }
        })();
      }
    }
  }, [currentView, currentProject]);

  // Project detail — backed by a TTL + in-flight cache
  const detailCacheRef = useRef<Map<number, { at: number; data: Awaited<ReturnType<typeof fetchProjectDetail>> }>>(new Map());
  const detailInFlightRef = useRef<Map<number, Promise<Awaited<ReturnType<typeof fetchProjectDetail>>>>>(new Map());

  const loadProjectDetail = useCallback(async (project: Project) => {
    // 1. In-memory cache
    const memCached = detailCacheRef.current.get(project.id);
    if (memCached && Date.now() - memCached.at < DETAIL_TTL_MS) {
      setProjectBranches(memCached.data.branches);
      setProjectTags(memCached.data.tags);
      setProjectCommits(memCached.data.commits);
      return;
    }
    // 2. Disk cache
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
    // 3. Network
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

  const launchFromIssue = useCallback(async (issue: Issue, options: { branch: string; session: string; worktree: string }): Promise<void> => {
    const task = await addTaskFromIssue(issue, options);
    if (!task.session) return;
    await launchTask(issue.iid, task.session);
  }, [addTaskFromIssue]);

  const launchExistingTask = useCallback(async (iid: number, session: string): Promise<void> => {
    await launchTask(iid, session);
  }, []);

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
      const data = await fetchIssues({ projectId: currentProject?.id ?? null, page: issuePage, perPage: PER_PAGE });
      let mergedItems: Issue[] = [];
      setIssues(prev => {
        mergedItems = mergeIssues(prev, data.issues);
        return mergedItems;
      });
      setIssueHasMore(data.hasMore);
      setIssuePage(p => p + 1);
      if (mergedItems.length > 0) {
        writeIssuesList(issueProjectKey || 'all', mergedItems, data.hasMore);
      }
    } finally {
      setLoading(false);
    }
  }, [loading, issueHasMore, issuePage, currentProject, issueProjectKey]);

  const fetchMoreProjects = useCallback(async () => {
    if (loading || !projectHasMore) return;
    setLoading(true);
    try {
      const data = await fetchProjects({ page: projectPage, perPage: PER_PAGE });
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
    tasks, issues, projects, sessions,
    projectBranches, projectTags, projectCommits, loading,
    issueHasMore, projectHasMore,
    loadProjectDetail,
    reloadTasks, reloadSessions, removeSession, addTaskFromIssue, launchFromIssue, launchExistingTask,
    fetchMoreIssues, fetchMoreProjects,
    invalidateDetailCache,
  };
}
