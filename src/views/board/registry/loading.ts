import { fetchTasks } from '../data/fetcher';

export interface LoadingPhaseDescriptor {
  key: string;
  label: string;
  icon?: string;
  fetch: (setDetail: (key: string, detail: string) => void) => Promise<string | void>;
}

export const LOADING_PHASES: LoadingPhaseDescriptor[] = [
  {
    key: 'config', label: 'Loading configuration...', icon: '⚙',
    fetch: async setDetail => {
      const { getGitLabConfig } = await import('../../../infrastructure/config/manager');
      try {
        const config = getGitLabConfig();
        setDetail('config', config.url || 'default');
        return config.url || 'default';
      } catch {
        setDetail('config', 'using defaults');
        return 'using defaults';
      }
    },
  },
  {
    key: 'detect', label: 'Detecting platform...', icon: '🔍',
    fetch: async setDetail => {
      const { resolveTrackerProject } = await import('../../../infrastructure/tracker/resolver');
      const { platform, projectId } = await resolveTrackerProject();
      const detail = `${platform}: ${projectId}`;
      setDetail('detect', detail);
      return detail;
    },
  },
  {
    key: 'connect', label: 'Connecting to tracker...', icon: '🔗',
    fetch: async setDetail => {
      const { createTracker } = await import('../../../application/tracker-provider-factory');
      const tracker = await createTracker();
      await tracker.listProjects({ perPage: 1 });
      setDetail('connect', tracker.platform);
      return tracker.platform;
    },
  },
  {
    key: 'tasks', label: 'Loading tasks...', icon: '●',
    fetch: async setDetail => {
      const { active, completed } = await fetchTasks();
      const detail = `${active.length} active, ${completed.length} done`;
      setDetail('tasks', detail);
      return detail;
    },
  },
  { key: 'ready', label: 'Ready to work!', icon: '✓', fetch: async () => undefined },
];
