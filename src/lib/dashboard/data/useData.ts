import { useState, useEffect, useCallback } from 'react';
import { Task, Issue, Project, TmuxSession } from '../../../types/dashboard';
import type { View } from '../types';
import {
  fetchTasks,
  fetchSessions,
  fetchIssues,
  fetchProjects,
  fetchProjectDetail,
  killSession,
  createTaskFromIssue,
} from './fetcher';

export function useData(currentView: View, currentProject: Project | null) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [completedTasks, setCompletedTasks] = useState<Task[]>([]);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [sessions, setSessions] = useState<TmuxSession[]>([]);
  const [projectIssues, setProjectIssues] = useState<Issue[]>([]);
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
          const data = await fetchIssues(currentProject?.id, pageToLoad, 50);
          if (isProjectChanged) {
            setIssues(data.issues);
          } else {
            setIssues(prev => [...prev, ...data.issues]);
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
            const data = await fetchProjects(1, 50);
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

  // Project detail
  const loadProjectDetail = useCallback(async (project: Project) => {
    const detail = await fetchProjectDetail(project.id);
    setProjectBranches(detail.branches);
    setProjectTags(detail.tags);
    setProjectCommits(detail.commits);
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
    await reloadSessions();
    await reloadTasks();
  }, [reloadSessions, reloadTasks]);

  const addTaskFromIssue = useCallback(async (issue: Issue, options: { branch: string; session: string; worktree: string }): Promise<Task> => {
    const task = await createTaskFromIssue(issue, options);
    await reloadTasks();
    return task;
  }, [reloadTasks]);

  const fetchMoreIssues = useCallback(async () => {
    if (loading || !issueHasMore) return;
    setLoading(true);
    try {
      const data = await fetchIssues(currentProject?.id, issuePage, 50);
      setIssues(prev => [...prev, ...data.issues]);
      setIssueHasMore(data.hasMore);
      setIssuePage(p => p + 1);
    } finally {
      setLoading(false);
    }
  }, [loading, issueHasMore, issuePage, currentProject]);

  const fetchMoreProjects = useCallback(async () => {
    if (loading || !projectHasMore) return;
    setLoading(true);
    try {
      const data = await fetchProjects(projectPage, 50);
      setProjects(prev => [...prev, ...data.projects]);
      setProjectHasMore(data.hasMore);
      setProjectPage(p => p + 1);
    } finally {
      setLoading(false);
    }
  }, [loading, projectHasMore, projectPage]);

  return {
    tasks, completedTasks, issues, projects, sessions, projectIssues,
    projectBranches, projectTags, projectCommits, loading,
    issueHasMore, projectHasMore,
    loadProjectDetail,
    reloadTasks, reloadSessions, removeSession, addTaskFromIssue,
    fetchMoreIssues, fetchMoreProjects,
  };
}
