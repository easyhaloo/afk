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

  // View change: load view-specific data
  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        switch (currentView) {
          case 'tasks':
          case 'completed': {
            const data = await fetchTasks();
            setTasks(data.active);
            setCompletedTasks(data.completed);
            break;
          }
          case 'issues': {
            const data = await fetchIssues(currentProject?.id);
            setIssues(data);
            setProjectIssues(data);
            break;
          }
          case 'projects': {
            const data = await fetchProjects();
            setProjects(data);
            break;
          }
        }
      } finally {
        setLoading(false);
      }
    })();
  }, [currentView, currentProject]);

  // Project detail data (when entering project detail, handled separately)
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

  return {
    tasks, completedTasks, issues, projects, sessions, projectIssues,
    projectBranches, projectTags, projectCommits, loading,
    loadProjectDetail,
    reloadTasks, reloadSessions, removeSession, addTaskFromIssue,
  };
}
