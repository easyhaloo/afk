/**
 * Loading phases registration - extensible via registry pattern
 *
 * Startup sequence mirrors the real initialization:
 *   config → detect platform → connect tracker → load data → ready
 */
import { LoadingPhaseRegistry } from './loading';
import { fetchTasks } from '../data/fetcher';

export function registerAllLoadingPhases(): void {
  const registry = LoadingPhaseRegistry.getInstance();

  registry.register({
    key: 'config',
    label: 'Loading configuration...',
    icon: '⚙',
    fetch: async (setDetail) => {
      const { getGitLabConfig } = await import('../../../infrastructure/config/manager');
      try {
        const config = getGitLabConfig();
        setDetail('config', `${config.url || 'default'}`);
        return `${config.url || 'default'}`;
      } catch {
        setDetail('config', 'using defaults');
        return 'using defaults';
      }
    },
  });

  registry.register({
    key: 'detect',
    label: 'Detecting platform...',
    icon: '🔍',
    fetch: async (setDetail) => {
      const { resolvePlatform, resolveTrackerProject } = await import('../../../infrastructure/tracker/resolver');
      const { platform, projectId } = await resolveTrackerProject();
      setDetail('detect', `${platform}: ${projectId}`);
      return `${platform}: ${projectId}`;
    },
  });

  registry.register({
    key: 'connect',
    label: 'Connecting to tracker...',
    icon: '🔗',
    fetch: async (setDetail) => {
      const { createTracker } = await import('../../../application/tracker-provider-factory');
      const tracker = await createTracker();
      const projects = await tracker.listProjects({ perPage: 1 });
      setDetail('connect', tracker.platform);
      return tracker.platform;
    },
  });

  registry.register({
    key: 'tasks',
    label: 'Loading tasks...',
    icon: '●',
    fetch: async (setDetail) => {
      const { active, completed } = await fetchTasks();
      setDetail('tasks', `${active.length} active, ${completed.length} done`);
      return `${active.length} active, ${completed.length} done`;
    },
  });

  registry.register({
    key: 'ready',
    label: 'Ready to work!',
    icon: '✓',
    fetch: async () => {
      // No-op: just shows completion state briefly
    },
  });
}
