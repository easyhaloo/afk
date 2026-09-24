import { useState, useEffect, useCallback, useRef } from 'react';
import { Task } from '../../../types/board';
import type { View } from '../types';
import type { Project, Branch, Tag, Commit } from '../../../domain/tracker/types';
import { fileLogger } from '../../../infrastructure/io/logger';
import {
  fetchTasks,
  fetchProjectDetail,
  fetchProjects,
} from './fetcher';
export { toRuntimeTask } from './fetcher';
import {
  readBacklogList,
  writeBacklogList,
  readProjectsList,
  writeProjectsList,
  readDetail,
  writeDetail,
  clearDetailCache as clearDiskDetailCache,
} from '../cache';
import {
  loadBacklogViewModels,
  type BacklogViewModel,
  type TuiManagementProviderBundle,
} from './backlog-adapter';
import type { TaskRuntimeManager } from '../../../application/runtime/task-runtime';

const PER_PAGE = 50;
const DETAIL_TTL_MS = 60_000;

/** Keep the provider call separately testable from React lifecycle code. */
export function loadDashboardBacklogs(
  management: TuiManagementProviderBundle,
): Promise<BacklogViewModel[]> {
  return loadBacklogViewModels(management);
}

export async function loadDashboardTasks(
  backlogs: readonly BacklogViewModel[],
  manager?: TaskRuntimeManager,
): Promise<Awaited<ReturnType<typeof fetchTasks>>> {
  return fetchTasks(manager, backlogs);
}

export function projectBacklogRuntime(backlogs: BacklogViewModel[], tasks: Task[]): BacklogViewModel[] {
  const taskByBacklogId = new Map(
    tasks
      .filter((task): task is Task & { backlogId: string } => typeof task.backlogId === 'string' && task.backlogId.length > 0)
      .map(task => [task.backlogId, task]),
  );
  return backlogs.map(backlog => {
    const task = taskByBacklogId.get(backlog.id);
    return {
      ...backlog,
      runId: task?.runId,
      runStatus: task?.runStatus,
      phase: task?.phase,
      progress: task?.progress,
    };
  });
}

/**
 * Read-only dashboard data flow. Backlogs come from the injected management
 * facade; Tasks come exclusively from the local execution runtime projection.
 */
export function useData(
  currentView: View,
  management?: TuiManagementProviderBundle | null,
) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [backlogs, setBacklogs] = useState<BacklogViewModel[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectBranches, setProjectBranches] = useState<Branch[]>([]);
  const [projectTags, setProjectTags] = useState<Tag[]>([]);
  const [projectCommits, setProjectCommits] = useState<Commit[]>([]);
  const [loading, setLoading] = useState(false);
  const [projectHasMore, setProjectHasMore] = useState(false);

  const projectPage = useRef(1);
  const detailCacheRef = useRef<Map<number, { at: number; data: Awaited<ReturnType<typeof fetchProjectDetail>> }>>(new Map());
  const detailInFlightRef = useRef<Map<number, Promise<Awaited<ReturnType<typeof fetchProjectDetail>>>>>(new Map());
  const backlogsRef = useRef<BacklogViewModel[]>([]);
  backlogsRef.current = backlogs;

  const reloadTasks = useCallback(async (backlogRows = backlogsRef.current) => {
    const data = await loadDashboardTasks(backlogRows);
    setTasks(data.active);
    return data;
  }, []);

  useEffect(() => {
    void reloadTasks().catch(err => {
      fileLogger.warn({ err }, 'failed to load runtime dashboard data');
    });
  }, [reloadTasks]);

  const refreshBacklogs = useCallback(async () => {
    if (!management) return;
    setLoading(true);
    try {
      const rows = await loadDashboardBacklogs(management);
      setBacklogs(rows);
      writeBacklogList('all', rows, false);
      try {
        const data = await reloadTasks(rows);
        const projectedRows = projectBacklogRuntime(rows, [...data.active, ...data.completed]);
        setBacklogs(projectedRows);
        writeBacklogList('all', projectedRows, false);
      } catch (err) {
        fileLogger.warn({ err }, 'failed to reproject runtime dashboard data');
      }
    } catch (err) {
      fileLogger.error({ err }, 'failed to list backlogs');
    } finally {
      setLoading(false);
    }
  }, [management, reloadTasks]);

  useEffect(() => {
    if (currentView !== 'backlogs' && currentView !== 'board') return;
    const cached = readBacklogList('all');
    if (cached) setBacklogs(cached.items as BacklogViewModel[]);
    void refreshBacklogs();
  }, [currentView, refreshBacklogs]);

  useEffect(() => {
    if (currentView !== 'projects' || projects.length > 0) return;
    const cached = readProjectsList();
    if (cached) {
      setProjects(cached.items as Project[]);
      setProjectHasMore(cached.hasMore);
    }
    setLoading(true);
    void fetchProjects({ page: 1, perPage: PER_PAGE }).then(data => {
      setProjects(data.projects);
      setProjectHasMore(data.hasMore);
      projectPage.current = 2;
      writeProjectsList(data.projects, data.hasMore);
    }).catch(err => {
      fileLogger.error({ err }, 'failed to list projects');
    }).finally(() => setLoading(false));
  }, [currentView, projects.length]);

  const loadProjectDetail = useCallback(async (project: Project) => {
    const memCached = detailCacheRef.current.get(project.id);
    if (memCached && Date.now() - memCached.at < DETAIL_TTL_MS) {
      setProjectBranches(memCached.data.branches);
      setProjectTags(memCached.data.tags);
      setProjectCommits(memCached.data.commits);
      return;
    }
    const diskCached = readDetail(project.id);
    if (diskCached) {
      setProjectBranches(diskCached.branches as Branch[]);
      setProjectTags(diskCached.tags as Tag[]);
      setProjectCommits(diskCached.commits as Commit[]);
      detailCacheRef.current.set(project.id, { at: Date.now(), data: diskCached });
      return;
    }
    let request = detailInFlightRef.current.get(project.id);
    if (!request) {
      request = fetchProjectDetail(project.id);
      detailInFlightRef.current.set(project.id, request);
    }
    try {
      const detail = await request;
      detailCacheRef.current.set(project.id, { at: Date.now(), data: detail });
      writeDetail(project.id, detail.branches, detail.tags, detail.commits);
      setProjectBranches(detail.branches);
      setProjectTags(detail.tags);
      setProjectCommits(detail.commits);
    } catch (err) {
      // Detail data is supplementary; an unavailable provider must not bring
      // down the interactive dashboard or leave an unhandled rejection.
      fileLogger.warn({ err, projectId: project.id }, 'failed to load project detail');
    } finally {
      detailInFlightRef.current.delete(project.id);
    }
  }, []);

  const fetchMoreProjects = useCallback(async () => {
    if (loading || !projectHasMore) return;
    setLoading(true);
    try {
      const data = await fetchProjects({ page: projectPage.current, perPage: PER_PAGE });
      setProjects(previous => {
        const merged = [...previous, ...data.projects];
        writeProjectsList(merged, data.hasMore);
        return merged;
      });
      setProjectHasMore(data.hasMore);
      projectPage.current += 1;
    } finally {
      setLoading(false);
    }
  }, [loading, projectHasMore]);

  const invalidateDetailCache = useCallback(() => {
    detailCacheRef.current.clear();
    detailInFlightRef.current.clear();
    clearDiskDetailCache();
    setProjectBranches([]);
    setProjectTags([]);
    setProjectCommits([]);
  }, []);

  return {
    tasks,
    backlogs,
    projects,
    projectBranches,
    projectTags,
    projectCommits,
    loading,
    projectHasMore,
    refreshBacklogs,
    loadProjectDetail,
    reloadTasks,
    fetchMoreProjects,
    invalidateDetailCache,
  };
}
