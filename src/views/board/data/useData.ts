import { useState, useEffect, useCallback, useRef } from 'react';
import { Task } from '../../../types/board';
import type { View } from '../types';
import type { Project, Branch, Tag, Commit } from '../../../domain/tracker/types';
import { fileLogger } from '../../../infrastructure/io/index';
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
import { projectDetailKey } from './fetcher';

const PER_PAGE = 50;
const DETAIL_TTL_MS = 60_000;
const TASK_REFRESH_INTERVAL_MS = 1_000;

export function startTaskPolling(
  reload: () => Promise<unknown> | void,
  intervalMs = TASK_REFRESH_INTERVAL_MS,
): () => void {
  let pending = false;
  const timer = setInterval(() => {
    if (pending) return;
    pending = true;
    void Promise.resolve(reload()).catch(() => undefined).finally(() => {
      pending = false;
    });
  }, intervalMs);
  return () => clearInterval(timer);
}

/** Keep the provider call separately testable from React lifecycle code. */
export function loadDashboardBacklogs(
  management: TuiManagementProviderBundle,
): Promise<BacklogViewModel[]> {
  return loadBacklogViewModels(management);
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
  const detailCacheRef = useRef<Map<string, { at: number; data: Awaited<ReturnType<typeof fetchProjectDetail>> }>>(new Map());
  const detailInFlightRef = useRef<Map<string, Promise<Awaited<ReturnType<typeof fetchProjectDetail>>>>>(new Map());

  const reloadTasks = useCallback(async () => {
    const data = await fetchTasks();
    setTasks(data.active);
    return data;
  }, []);

  useEffect(() => {
    const refresh = () => reloadTasks().catch(err => {
      fileLogger.warn({ err }, 'failed to load runtime dashboard data');
    });
    void refresh();
    return startTaskPolling(refresh);
  }, [reloadTasks]);

  const refreshBacklogs = useCallback(async () => {
    if (!management) return;
    setLoading(true);
    try {
      const rows = await loadDashboardBacklogs(management);
      setBacklogs(rows);
      writeBacklogList('all', rows, false);
    } catch (err) {
      fileLogger.error({ err }, 'failed to list backlogs');
    } finally {
      setLoading(false);
    }
  }, [management]);

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
    const cacheKey = projectDetailKey(project);
    const memCached = detailCacheRef.current.get(cacheKey);
    if (memCached && Date.now() - memCached.at < DETAIL_TTL_MS) {
      setProjectBranches(memCached.data.branches);
      setProjectTags(memCached.data.tags);
      setProjectCommits(memCached.data.commits);
      return;
    }
    const diskCached = readDetail(cacheKey);
    if (diskCached) {
      setProjectBranches(diskCached.branches as Branch[]);
      setProjectTags(diskCached.tags as Tag[]);
      setProjectCommits(diskCached.commits as Commit[]);
      detailCacheRef.current.set(cacheKey, { at: Date.now(), data: diskCached });
      return;
    }
    let request = detailInFlightRef.current.get(cacheKey);
    if (!request) {
      request = fetchProjectDetail(project);
      detailInFlightRef.current.set(cacheKey, request);
    }
    try {
      const detail = await request;
      detailCacheRef.current.set(cacheKey, { at: Date.now(), data: detail });
      writeDetail(cacheKey, detail.branches, detail.tags, detail.commits);
      setProjectBranches(detail.branches);
      setProjectTags(detail.tags);
      setProjectCommits(detail.commits);
    } catch (err) {
      // Detail data is supplementary; an unavailable provider must not bring
      // down the interactive dashboard or leave an unhandled rejection.
      fileLogger.warn({ err, projectId: project.id, platform: project.platform }, 'failed to load project detail');
    } finally {
      detailInFlightRef.current.delete(cacheKey);
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
