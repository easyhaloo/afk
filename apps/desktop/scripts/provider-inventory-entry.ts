import { createGlobalWorkItemCatalogs, type GlobalTrackerPlatform } from '@afk/runtime/infrastructure/provider/tracker-provider-factory';
import { collectGlobalWorkItemInventory } from '@afk/runtime/infrastructure/provider/inventory';

export function collectProviderInventory(platform: GlobalTrackerPlatform) {
  return collectGlobalWorkItemInventory(createGlobalWorkItemCatalogs(platform));
}
