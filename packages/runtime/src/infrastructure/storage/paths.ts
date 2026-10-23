import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export interface ProviderAccountIdentity {
  platform: 'github' | 'gitlab';
  host: string;
  accountId: string;
}

export function localStoragePaths(root = join(homedir(), '.afk', 'storage')) {
  const directory = resolve(root);
  return { root: directory, config: join(directory, 'local-config.sqlite'), inventory: join(directory, 'inventory') };
}

export function providerHost(host: string): string {
  const url = new URL(host.includes('://') ? host : `https://${host}`);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Provider host must contain only a protocol, hostname and optional port');
  }
  return url.host.toLowerCase();
}

export function inventoryNamespace(identities: readonly ProviderAccountIdentity[]): string {
  if (!identities.length) throw new Error('Verified Provider identity is required');
  const entries = identities.map(identity => {
    if (!['github', 'gitlab'].includes(identity.platform) || !identity.accountId.trim() || identity.accountId.trim() !== identity.accountId) {
      throw new Error('Invalid Provider identity');
    }
    return JSON.stringify([identity.platform, providerHost(identity.host), identity.accountId]);
  });
  return createHash('sha256').update(JSON.stringify([...new Set(entries)].sort())).digest('hex');
}

/**
 * Namespace of a fully verified account set, or `undefined` when any account
 * is unverified.
 *
 * The namespace identifies the authenticated account set as a whole. An
 * unverified account has no stable user id, so a store opened for the
 * remaining accounts would be the wrong store for whichever account the
 * unverified one turns out to be. Callers must not open a store — not even
 * another account's — while the set is incomplete.
 */
export function verifiedInventoryNamespace(
  identities: readonly (ProviderAccountIdentity | undefined)[],
): string | undefined {
  if (!identities.length) return undefined;
  const verified = identities.filter((identity): identity is ProviderAccountIdentity => Boolean(identity));
  if (verified.length !== identities.length) return undefined;
  return inventoryNamespace(verified);
}
