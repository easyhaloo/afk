import { createGlobalWorkItemCatalogs, type GlobalTrackerPlatform } from '../../src/infrastructure/provider/tracker-provider-factory';
import { collectGlobalWorkItemInventory } from '../../src/infrastructure/provider/inventory';

export function collectProviderInventory(platform: GlobalTrackerPlatform) {
  return collectGlobalWorkItemInventory(createGlobalWorkItemCatalogs(platform));
}
