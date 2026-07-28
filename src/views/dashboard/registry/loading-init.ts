/**
 * Loading phases registration - extensible via registry pattern
 *
 * Startup sequence mirrors the real initialization:
 *   config → detect platform → connect tracker → load data → ready
 */
import { LoadingPhaseRegistry } from './loading';
import { fetchTasks, fetchSessions } from '../data/fetcher';
import { getGitLabConfig } from '../../../lib/core/config/manager';

export function registerAllLoadingPhases(): void {
  const registry = LoadingPhaseRegistry.getInstance();

  registry.register({
    key: 'config',
    label: 'Loading configuration...',
    icon: '⚙',
    fetch: async () => {
      // Configuration is lazy-loaded on first access.
      // Touch the config to load it during splash.
      try {
        getGitLabConfig();
      } catch {
        // Config may fail if not configured yet — that's ok
      }
    },
  });

  registry.register({
    key: 'detect',
    label: 'Detecting platform...',
    icon: '🔍',
    fetch: async () => {
      // Platform detection from git remote
      const { detectPlatform } = await import('../../../lib/core/tracker/detect');
      await detectPlatform();
    },
  });

  registry.register({
    key: 'connect',
    label: 'Connecting to tracker...',
    icon: '🔗',
    fetch: async () => {
      // Create tracker client and verify connectivity
      const { createTrackerClient } = await import('../../../lib/client-factory');
      const tracker = await createTrackerClient();
      // Verify by listing projects (lightweight call)
      await tracker.listProjects({ perPage: 1 });
    },
  });

  registry.register({
    key: 'tasks',
    label: 'Loading tasks...',
    icon: '●',
    fetch: async () => {
      await fetchTasks();
    },
  });

  registry.register({
    key: 'sessions',
    label: 'Loading sessions...',
    icon: '○',
    fetch: async () => {
      await fetchSessions();
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
