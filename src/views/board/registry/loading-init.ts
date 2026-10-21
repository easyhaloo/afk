/**
 * Loading phases registration - extensible via registry pattern
 *
 * Startup sequence mirrors the real initialization:
 *   config → detect platform → connect tracker → load data → ready
 */
import { LoadingPhaseRegistry } from './loading.js';
import { fetchTasks } from '../data/fetcher.js';
import type { TrackerProjectReader } from '@afk/application';
import type { BoardRuntimePorts } from '../../app/runtime-ports.js';

export function registerAllLoadingPhases(ports: BoardRuntimePorts): void {
  const registry = LoadingPhaseRegistry.getInstance();

  registry.register({
    key: 'config',
    label: 'Loading configuration...',
    icon: '⚙',
    fetch: async (setDetail) => {
      // The tracker URL is read through the configuration port, so the board
      // never has to know which file the configuration came from.
      try {
        const config = ports.configuration.gitLab();
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
      const { resolvePlatform, resolveTrackerProject } = await import('@afk/infrastructure');
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
      const { createTracker } = await import('@afk/infrastructure');
      const tracker: TrackerProjectReader = await createTracker();
      // Listing a page is the connection check; the board never shows it.
      await tracker.listProjects({ perPage: 1 });
      setDetail('connect', tracker.platform);
      return tracker.platform;
    },
  });

  registry.register({
    key: 'tasks',
    label: 'Loading tasks...',
    icon: '●',
    fetch: async (setDetail) => {
      const { active, completed } = await fetchTasks(ports.taskRuntime);
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
