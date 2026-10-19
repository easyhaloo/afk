import { createGlobalWorkItemCatalogs, createManagementProviders, type GlobalTrackerPlatform } from '@afk/infrastructure';
import { collectGlobalWorkItemInventory } from '@afk/application';
import { executeWorkItem } from '@afk/execution';

/**
 * The desktop's runtime bindings, bundled as CommonJS.
 *
 * The Electron main process loads this module instead of importing the
 * packages directly, so the end-to-end suite can replace it wholesale with
 * a fixture: it intercepts the provider catalog, the management provider and
 * the work item execution in one place.
 */
export function collectProviderInventory(platform: GlobalTrackerPlatform) {
  return collectGlobalWorkItemInventory(createGlobalWorkItemCatalogs(platform));
}

export { createManagementProviders, executeWorkItem };
