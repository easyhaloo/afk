import { createGlobalWorkItemCatalogs, type GlobalTrackerPlatform } from '../../src/application/tracker-provider-factory';
import { collectGlobalWorkItemInventory } from '../../src/application/work-items/inventory';

export function collectProviderInventory(platform: GlobalTrackerPlatform) {
  return collectGlobalWorkItemInventory(createGlobalWorkItemCatalogs(platform));
}
