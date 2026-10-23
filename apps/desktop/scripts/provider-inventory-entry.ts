import { createGlobalWorkItemCatalogs, type GlobalTrackerPlatform } from '@afk/runtime/infrastructure/provider/tracker-provider-factory';
import { collectGlobalWorkItemInventory } from '@afk/runtime/infrastructure/provider/inventory';
import { resolveProviderAccountIdentities } from '@afk/runtime/infrastructure/provider/tracker-provider-factory';
import type { ProviderAccountIdentity } from '@afk/runtime/domain/work-item/provider-types';

function verifiedIdentities(identities: Array<ProviderAccountIdentity | undefined>): ProviderAccountIdentity[] {
  return identities.filter((identity): identity is ProviderAccountIdentity => Boolean(identity));
}

export async function collectProviderInventorySnapshot(platform: GlobalTrackerPlatform) {
  const catalogs = createGlobalWorkItemCatalogs(platform);
  const [inventory, resolution] = await Promise.all([
    collectGlobalWorkItemInventory(catalogs),
    resolveProviderAccountIdentities(catalogs),
  ]);
  // The inventory is returned even when an account is unverified: the mirror
  // stays closed, but the live data is still worth showing.
  return {
    inventory,
    identities: verifiedIdentities(resolution.identities),
    identityFailures: resolution.failures,
  };
}

/**
 * The identities that open the account-namespaced mirror. A partially
 * verified set has no stable namespace, so it is refused instead of pointing
 * the store at the wrong account.
 */
export async function getProviderAccountIdentities(platform: GlobalTrackerPlatform = "all") {
  const resolution = await resolveProviderAccountIdentities(createGlobalWorkItemCatalogs(platform));
  if (resolution.failures.length) {
    throw new Error(`Verified Provider account identity is unavailable: ${resolution.failures.map(failure => `${failure.platform}/${failure.scopeKey}: ${failure.message}`).join('; ')}`);
  }
  return verifiedIdentities(resolution.identities);
}

export function collectProviderInventory(platform: GlobalTrackerPlatform) {
  return collectProviderInventorySnapshot(platform).then(result => result.inventory);
}
