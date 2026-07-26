import { useState, useEffect, useCallback, useRef } from 'react';
import { Task, Issue, Project, TmuxSession } from '../../../types/dashboard';
import type { View } from '../types';
import {
  fetchTasks,
  fetchSessions,
  fetchProjectDetail,
  killSession,
  createTaskFromIssue,
  issueService,
  projectService,
} from './fetcher';

const PER_PAGE = 50;
/** How long to keep a project-detail response cached before refetching. */
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
      const isProjectChanged = projectKey !== issueProjectKey;
      if (isProjectChanged) {
        setIssuePage(1);
        setIssues([]);
        setIssueProjectKey(projectKey);
      }
      const pageToLoad = isProjectChanged ? 1 : issuePage;
      (async () => {
        setLoading(true);
        try {
          const data = await issueService.listIssues(currentProject?.id, pageToLoad, PER_PAGE);
          if (isProjectChanged) {
            setIssues(data.issues);
          } else {
            setIssues(prev => mergeIssues(prev, data.issues));
          }
          setIssueHasMore(data.hasMore);
          if (!isProjectChanged) setIssuePage(p => p + 1);
        } finally {
          setLoading(false);
        }
      })();
    }

    if (currentView === 'projects') {
      if (projects.length === 0) {
        (async () => {
          setLoading(true);
          try {
            const data = await projectService.listProjects(1, PER_PAGE);
            setProjects(data.projects);
            setProjectHasMore(data.hasMore);
            setProjectPage(2);
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
    const cached = detailCacheRef.current.get(project.id);
    if (cached && Date.now() - cached.at < DETAIL_TTL_MS) {
      setProjectBranches(cached.data.branches);
      setProjectTags(cached.data.tags);
      setProjectCommits(cached.data.commits);
      return;
    }
    let p = detailInFlightRef.current.get(project.id);
    if (!p) {
      p = fetchProjectDetail(project.id);
      detailInFlightRef.current.set(project.id, p);
    }
    try {
      const detail = await p;
      detailCacheRef.current.set(project.id, { at: Date.now(), data: detail });
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

  /** Drop all cached project-detail responses — used by full refresh. */
  const invalidateDetailCache = useCallback(() => {
    detailCacheRef.current.clear();
    setProjectBranches([]);
    setProjectTags([]);
    setProjectCommits([]);
  }, []);

  const fetchMoreIssues = useCallback(async () => {
    if (loading || !issueHasMore) return;
    setLoading(true);
    try {
      const data = await issueService.listIssues(currentProject?.id, issuePage, PER_PAGE);
      setIssues(prev => mergeIssues(prev, data.issues));
      setIssueHasMore(data.hasMore);
      setIssuePage(p => p + 1);
    } finally {
      setLoading(false);
    }
  }, [loading, issueHasMore, issuePage, currentProject, issueProjectKey]);

  const fetchMoreProjects = useCallback(async () => {
    if (loading || !projectHasMore) return;
    setLoading(true);
    try {
      const data = await projectService.listProjects(projectPage, PER_PAGE);
      setProjects(prev => [...prev, ...data.projects]);
      setProjectHasMore(data.hasMore);
      setProjectPage(p => p + 1);
    } finally {
      setLoading(false);
    }
  }, [loading, projectHasMore, projectPage]);

  return {
    tasks, completedTasks, issues, projects, sessions,
    projectBranches, projectTags, projectCommits, loading,
    issueHasMore, projectHasMore,
    loadProjectDetail,
    reloadTasks, reloadSessions, removeSession, addTaskFromIssue,
    fetchMoreIssues, fetchMoreProjects,
    invalidateDetailCache,
  };
}
