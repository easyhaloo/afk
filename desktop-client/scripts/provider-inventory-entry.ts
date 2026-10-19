import { createGlobalWorkItemCatalogs, type GlobalTrackerPlatform } from '@afk/infrastructure';
import { collectGlobalWorkItemInventory } from '@afk/application';

export function collectProviderInventory(platform: GlobalTrackerPlatform) {
  return collectGlobalWorkItemInventory(createGlobalWorkItemCatalogs(platform));
}
