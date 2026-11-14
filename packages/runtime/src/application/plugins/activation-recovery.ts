import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { dump } from 'js-yaml';
import { validatePluginId } from '../../plugin-sdk/profile.js';
import { pluginConfigurationPath, readPluginConfiguration, validatePluginConfig, type InstalledPluginEntry, type PluginConfiguration } from './configuration.js';
import { readInstalledPlugin, resolveInstalledPluginEntry, type InstalledPluginRecord } from './manager.js';

export async function atomicWrite(path: string, value: string): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, value, { mode: 0o600 });
    await fs.rename(temporary, path);
  } finally { await fs.rm(temporary, { force: true }); }
}

export async function withManagerLock<T>(directory: string, operation: () => Promise<T>): Promise<T> {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await ownedDirectory(directory);
  const path = join(directory, '.manager.lock');
  const recovery = `${path}.recovery`;
  const identity = JSON.stringify({ pid: process.pid, token: randomUUID() });
  let lock;
  try {
    if (await fs.lstat(recovery).then(() => true, () => false)) throw new Error('Plugin manager lock recovery is active or unknown');
    lock = await fs.open(path, 'wx', 0o600);
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      // Serialize dead-owner reclamation so a competing reclaimer cannot unlink a new owner's lock.
      let claim;
      try { claim = await fs.open(recovery, 'wx', 0o600); }
      catch { throw new Error('Another plugin operation holds .manager.lock; retry after it finishes'); }
      let reclaimed = false;
      try {
        const value = await fs.readFile(path, 'utf8');
        if (deadOwner(value)) { await fs.unlink(path); reclaimed = true; }
      } finally { await claim.close(); await fs.unlink(recovery); }
      if (reclaimed) return withManagerLock(directory, operation);
      throw new Error('Another plugin operation holds .manager.lock; retry after it finishes');
    }
    throw error;
  }
  try {
    await lock.writeFile(identity);
    if (await fs.lstat(recovery).then(() => true, () => false)) throw new Error('Plugin manager lock recovery is active or unknown');
    return await operation();
  } finally {
    await lock.close();
    if (await fs.readFile(path, 'utf8') !== identity) throw new Error('Plugin manager lock identity changed; unknown owner retained');
    await fs.unlink(path);
  }
}

function deadOwner(value: string, runtime = false): boolean {
  try {
    const owner = JSON.parse(value) as { pid?: number; token?: string; kind?: string };
    if (!Number.isSafeInteger(owner.pid) || owner.pid! <= 0 || typeof owner.token !== 'string' || !owner.token || (runtime && owner.kind !== 'runtime')) return false;
    try { process.kill(owner.pid!, 0); }
    catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
  } catch { /* Unreadable ownership stays protected. */ }
  return false;
}

export function sameIdentity(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export interface PendingActivation {
  readonly id: string;
  phase: 'prepared' | 'published' | 'restoring' | 'confirmed';
  readonly stage: string;
  readonly backup?: string;
  readonly previous?: InstalledPluginRecord;
  readonly previousUsable?: boolean;
  readonly next: InstalledPluginRecord;
  readonly previousEntry?: InstalledPluginEntry;
  readonly nextEntry: InstalledPluginEntry;
}

export function pendingPath(directory: string, id: string): string {
  validatePluginId(id);
  return join(directory, `.pending-${id}.json`);
}

export async function writePending(directory: string, pending: PendingActivation): Promise<void> {
  await atomicWrite(pendingPath(directory, pending.id), JSON.stringify(pending));
}

async function ownedDirectory(path: string): Promise<void> {
  if (await fs.realpath(path) !== join(await fs.realpath(dirname(path)), basename(path))) throw new Error('Plugin recovery refuses a foreign or symlinked directory');
}

export async function readPending(directory: string, id: string): Promise<PendingActivation | undefined> {
  let pending: PendingActivation;
  try { pending = JSON.parse(await fs.readFile(pendingPath(directory, id), 'utf8')) as PendingActivation; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  if (pending.id !== id || pending.next?.id !== id || pending.next?.manifest?.id !== id ||
    pending.nextEntry?.id !== id || (pending.previousEntry && pending.previousEntry.id !== id) ||
    (pending.previous && (pending.previous.id !== id || pending.previous.manifest.id !== id)) ||
    !['prepared', 'published', 'restoring', 'confirmed'].includes(pending.phase) ||
    !/^\.install-[A-Za-z0-9]+$/.test(pending.stage) ||
    (pending.previous ? !pending.backup?.startsWith(`.previous-${id}-`) || !/^\.[a-zA-Z0-9.-]+$/.test(pending.backup) : pending.backup !== undefined)) {
    throw new Error('Invalid pending plugin identity or recovery path');
  }
  await ownedDirectory(directory);
  return pending;
}

export async function verifyInstallation(directory: string, expected: InstalledPluginRecord, verifyEntry = true): Promise<void> {
  await ownedDirectory(directory);
  const current = await readInstalledPlugin(directory);
  if (!sameIdentity(current, expected) || current?.version !== current?.manifest.version) throw new Error('Plugin recovery installation identity changed');
  if (verifyEntry) await resolveInstalledPluginEntry(directory, expected);
}

export async function assertInactive(directory: string, id: string): Promise<void> {
  validatePluginId(id);
  try { await fs.lstat(join(directory, `.active-${id}.json`)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  const path = join(directory, `.active-${id}.json`);
  if (deadOwner(await fs.readFile(path, 'utf8'), true)) { await fs.unlink(path); return; }
  // Unknown owners and live/reused PIDs stay protected, including worker ownership.
  throw new Error(`Plugin '${id}' has an active or unknown runtime/worker reference`);
}

/** Called while holding .manager.lock. Runtime disposal owns the release. */
export async function activationLease(directory: string, id: string): Promise<() => Promise<void>> {
  await assertInactive(directory, id);
  const path = join(directory, `.active-${id}.json`);
  const identity = JSON.stringify({ kind: 'runtime', pid: process.pid, token: randomUUID() });
  await fs.writeFile(path, identity, { flag: 'wx', mode: 0o600 });
  let released = false;
  return async () => {
    if (released) return;
    await withManagerLock(directory, async () => {
      if (await fs.readFile(path, 'utf8') !== identity) throw new Error('Plugin runtime reference identity changed');
      await fs.unlink(path);
      released = true;
    });
  };
}

type ProtectDependencies = (configuration: PluginConfiguration, next: PluginConfiguration, previous: InstalledPluginRecord) => Promise<void>;

/** Recover a journaled upgrade, including interruptions between the two renames. Caller holds the lock. */
export async function restorePending(homeDir: string, id: string, protect: ProtectDependencies, expected?: InstalledPluginRecord, installationFailure = false): Promise<boolean> {
  const directory = join(homeDir, '.afk', 'plugins');
  const pending = await readPending(directory, id);
  if (!pending) return false;
  if (expected && !sameIdentity(pending.next, expected)) throw new Error('Pending activation identity changed');
  if (pending.phase === 'confirmed') return false;
  if (!pending.previous || !pending.backup) return false;
  if (pending.previousUsable === false && !installationFailure) throw new Error('Previous installation was damaged; activation recovery is unavailable');
  await assertInactive(directory, id);
  const destination = join(directory, id), backup = join(directory, pending.backup);
  const current = await readInstalledPlugin(destination);
  if (!current && await fs.lstat(destination).then(() => true, () => false)) throw new Error('Plugin recovery refuses a directory with missing installation identity');
  const alreadyRestored = sameIdentity(current, pending.previous);
  if (current && !alreadyRestored && !sameIdentity(current, pending.next)) throw new Error('Plugin recovery installation identity changed');
  if (!current && pending.phase === 'published') throw new Error('Plugin recovery destination is missing');
  if (alreadyRestored) await verifyInstallation(destination, pending.previous, pending.previousUsable !== false);
  else await verifyInstallation(backup, pending.previous, pending.previousUsable !== false);
  if (current && !alreadyRestored) await verifyInstallation(destination, pending.next);
  const configuration = readPluginConfiguration(homeDir);
  const entry = configuration.plugins.find(candidate => candidate.id === id);
  if (configuration.plugins.filter(candidate => candidate.id === id).length !== 1 ||
    (!sameIdentity(entry, pending.nextEntry) && !sameIdentity(entry, pending.previousEntry))) {
    throw new Error('Plugin configuration changed concurrently; activation recovery refused');
  }
  const next = { ...configuration, plugins: configuration.plugins.flatMap(candidate => candidate.id !== id ? [candidate] : pending.previousEntry ? [pending.previousEntry] : []) };
  validatePluginConfig(pending.previous.manifest.configSchema, pending.previousEntry?.config ?? {});
  await protect(configuration, next, pending.previous);
  if (!sameIdentity(configuration, readPluginConfiguration(homeDir))) throw new Error('Plugin configuration changed concurrently; activation recovery refused');
  pending.phase = 'restoring';
  await writePending(directory, pending);
  if (!alreadyRestored) {
    if (current) {
      const failed = join(directory, pending.backup.replace('.previous-', '.failed-'));
      if (await fs.lstat(failed).then(() => true, () => false)) throw new Error('Failed plugin retention path already exists; recovery refused');
      // ponytail: retain whole directories to preserve plugin-written data; add explicit data-aware GC if disk use matters.
      await fs.rename(destination, failed);
    }
    await fs.rename(backup, destination);
  }
  await verifyInstallation(destination, pending.previous, pending.previousUsable !== false);
  if (!sameIdentity(configuration, readPluginConfiguration(homeDir))) throw new Error('Plugin configuration changed during disk recovery; pending recovery retained');
  await atomicWrite(pluginConfigurationPath(homeDir), dump(next));
  await fs.rm(pendingPath(directory, id));
  return true;
}
