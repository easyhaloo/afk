import { createGlobalWorkItemCatalogs, type GlobalTrackerPlatform } from '@afk/runtime/infrastructure/provider/tracker-provider-factory';
import { collectGlobalWorkItemInventory } from '@afk/runtime/infrastructure/provider/inventory';
import { resolveProviderAccountIdentities } from '@afk/runtime/infrastructure/provider/tracker-provider-factory';

export async function collectProviderInventorySnapshot(platform: GlobalTrackerPlatform) {
  const catalogs = createGlobalWorkItemCatalogs(platform);
  const [inventory, identities] = await Promise.all([
    collectGlobalWorkItemInventory(catalogs),
    resolveProviderAccountIdentities(catalogs),
  ]);
  return { inventory, identities };
}

export async function getProviderAccountIdentities(platform: GlobalTrackerPlatform = "all") {
  return resolveProviderAccountIdentities(createGlobalWorkItemCatalogs(platform));
}

export function collectProviderInventory(platform: GlobalTrackerPlatform) {
  return collectProviderInventorySnapshot(platform).then(result => result.inventory);
}
