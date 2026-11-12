import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, readlink, rename, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { glob } from 'glob';
import { simpleGit } from 'simple-git';
import { FilesystemClaimLock } from '../../domain/backlog/claim.js';
import { resolveWorkspaceRoot } from '../../shared/workspace-paths.js';

const mutableState = new Set(['.pnpm-task-run-state-v1', '.pnpm-workspace-state-v1.json']);
const ignore = ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/.afk/**'];

async function exists(path: string): Promise<boolean> {
  return lstat(path).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
}

async function validateTarget(root: string, target: string): Promise<void> {
  const path = relative(resolve(root), resolve(target));
  if (!path || path.startsWith(`..${sep}`) || path === '..' || isAbsolute(path)) throw new Error('dependency path escapes checkout');
  let parent = resolve(root);
  for (const segment of ['', ...path.split(sep).slice(0, -1)]) {
    parent = join(parent, segment);
    try {
      if ((await lstat(parent)).isSymbolicLink()) throw new Error(`dependency parent must not be a symlink: ${parent}`);
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') break; throw error; }
  }
}

export async function dependencyKey(repoRoot: string): Promise<string | undefined> {
  const locks = await glob(['**/pnpm-lock.yaml', '**/package-lock.json', '**/yarn.lock'], { cwd: repoRoot, ignore, nodir: true });
  if (!locks.length) return undefined;
  const manifests = await glob(['**/package.json', '**/pnpm-workspace.yaml', '**/.npmrc', '**/.pnpmfile.cjs', '**/patches/**'], { cwd: repoRoot, ignore, nodir: true });
  const hash = createHash('sha256').update(`${process.platform}:${process.arch}:${process.versions.modules}`);
  for (const path of [...new Set([...locks, ...manifests])].sort()) {
    if ((await lstat(join(repoRoot, path))).isSymbolicLink()) throw new Error(`dependency input must not be a symlink: ${path}`);
    hash.update(path).update('\0').update(await readFile(join(repoRoot, path))).update('\0');
  }
  return hash.digest('hex');
}

export async function directoryBytes(path: string): Promise<number> {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink()) return metadata.size;
  if (!metadata.isDirectory()) return metadata.size;
  const sizes = await Promise.all((await readdir(path)).map(entry => directoryBytes(join(path, entry))));
  return sizes.reduce((total, size) => total + size, metadata.size);
}

export async function linkNodeModules(source: string, target: string, sourceRoot: string, targetRoot: string): Promise<void> {
  await validateTarget(targetRoot, target);
  if (await exists(target) || !await exists(source)) return;
  if (!(await lstat(source)).isDirectory()) return;
  await mkdir(target, { recursive: true });
  const linkEntry = async (entry: string) => {
    const sourcePath = join(source, entry);
    const targetPath = join(target, entry);
    const metadata = await lstat(sourcePath);
    if (metadata.isSymbolicLink()) {
      const destination = resolve(dirname(sourcePath), await readlink(sourcePath));
      const destinationRelative = relative(sourceRoot, destination);
      if (!destinationRelative.split(sep).includes('node_modules') && !destinationRelative.startsWith('..') && !isAbsolute(destinationRelative)) {
        await symlink(join(targetRoot, destinationRelative), targetPath, 'dir');
        return;
      }
    }
    await symlink(sourcePath, targetPath, metadata.isDirectory() ? 'dir' : 'file');
  };
  for (const entry of await readdir(source)) {
    if (mutableState.has(entry)) continue;
    if (entry.startsWith('@') && (await lstat(join(source, entry))).isDirectory()) {
      await mkdir(join(target, entry));
      for (const child of await readdir(join(source, entry))) await linkEntry(join(entry, child));
    } else await linkEntry(entry);
  }
}

export class DependencyPool {
  private readonly locks: FilesystemClaimLock;
  constructor(readonly root = join(resolveWorkspaceRoot(), 'deps'), private readonly maxBytes = 8 * 1024 ** 3) {
    this.locks = new FilesystemClaimLock(join(root, '.locks'), { gateTimeoutMs: 120_000, gateRetryMs: 50 });
  }

  async attach(repoRoot: string): Promise<boolean> {
    const key = await dependencyKey(repoRoot);
    if (!key) return false;
    return this.locks.withExclusiveOperation('dependencies/pool/operations', async () => {
      const entry = join(this.root, key);
      if (!await exists(join(entry, 'complete.json'))) return false;
      const paths = await this.paths(entry);
      if ((await Promise.all(paths.map(path => exists(join(repoRoot, path))))).some(Boolean)) return false;
      await this.pin(entry, repoRoot);
      for (const path of paths) await linkNodeModules(join(entry, 'layout', path), join(repoRoot, path), join(entry, 'layout'), repoRoot);
      const now = new Date();
      await utimes(entry, now, now);
      return true;
    });
  }

  async capture(repoRoot: string): Promise<boolean> {
    if (await exists(join(repoRoot, '.git'))
      && (await simpleGit(repoRoot).raw(['ls-files', '--', 'node_modules', '**/node_modules/**'])).trim()) return false;
    const key = await dependencyKey(repoRoot);
    if (!key) return false;
    return this.locks.withExclusiveOperation('dependencies/pool/operations', async () => {
      const entry = join(this.root, key);
      if (await exists(join(entry, 'complete.json'))) {
        await this.pin(entry, repoRoot);
        return true;
      }
      const paths = await glob('**/node_modules', { cwd: repoRoot, ignore: ['**/node_modules/**/node_modules', '**/.git/**'], dot: true });
      const roots = paths.filter(path => path.split('/').filter(segment => segment === 'node_modules').length === 1).sort();
      if (!roots.length) return false;
      for (const path of roots) {
        if (!(await lstat(join(repoRoot, path))).isDirectory()) return false;
        const links = await glob('**/*', { cwd: join(repoRoot, path), dot: true, follow: false, nodir: false });
        for (const link of links) {
          const absolute = join(repoRoot, path, link);
          if (!(await lstat(absolute)).isSymbolicLink()) continue;
          const linkValue = await readlink(absolute);
          const destination = resolve(dirname(absolute), linkValue);
          const destinationRelative = relative(repoRoot, destination);
          if (destinationRelative.startsWith('..') || isAbsolute(destinationRelative)) return false;
          if (!destinationRelative.split(sep).includes('node_modules') && link.split('/').length > (link.startsWith('@') ? 2 : 1)) return false;
          if (isAbsolute(linkValue)) {
            await rm(absolute);
            await symlink(relative(dirname(absolute), destination), absolute);
          }
        }
      }
      const staging = `${entry}.${randomUUID()}.tmp`;
      await mkdir(join(staging, 'layout'), { recursive: true });
      const moved: string[] = [];
      try {
        for (const path of roots) {
          await mkdir(dirname(join(staging, 'layout', path)), { recursive: true });
          for (const state of mutableState) await rm(join(repoRoot, path, state), { recursive: true, force: true });
          await rename(join(repoRoot, path), join(staging, 'layout', path));
          moved.push(path);
        }
        await writeFile(join(staging, 'complete.json'), JSON.stringify({ paths: roots }));
        await rename(staging, entry);
      } catch (error) {
        for (const path of moved.reverse()) await rename(join(staging, 'layout', path), join(repoRoot, path));
        await rm(staging, { recursive: true, force: true });
        throw error;
      }
      await this.pin(entry, repoRoot);
      for (const path of roots) await linkNodeModules(join(entry, 'layout', path), join(repoRoot, path), join(entry, 'layout'), repoRoot);
      return true;
    });
  }

  async release(repoRoot: string, clearLocal = false): Promise<void> {
    await this.locks.withExclusiveOperation('dependencies/pool/operations', async () => {
      if (clearLocal && (await simpleGit(repoRoot).raw(['ls-files', '--', 'node_modules', '**/node_modules/**'])).trim()) {
        throw new Error('refusing to remove tracked dependencies');
      }
      for (const key of await readdir(this.root)) {
        if (!/^[a-f0-9]{64}$/.test(key)) continue;
        const entry = join(this.root, key);
        const pin = join(entry, 'pins', createHash('sha256').update(resolve(repoRoot)).digest('hex'));
        if (!await exists(pin)) continue;
        for (const path of await this.paths(entry)) {
          await validateTarget(repoRoot, join(repoRoot, path));
          await rm(join(repoRoot, path), { recursive: true, force: true });
        }
        await rm(pin, { force: true });
      }
      if (clearLocal) {
        const paths = await glob('**/node_modules', { cwd: repoRoot, ignore: ['**/node_modules/**/node_modules', '**/.git/**'], dot: true });
        for (const path of paths.filter(path => path.split('/').filter(segment => segment === 'node_modules').length === 1)) {
          await validateTarget(repoRoot, join(repoRoot, path));
          await rm(join(repoRoot, path), { recursive: true, force: true });
        }
      }
      await this.pruneUnlocked();
    });
  }

  /**
   * Reclaim crashed staging directories and run the budget-bounded LRU
   * eviction. Safe to call at any time; never touches pinned entries.
   */
  async prune(now = Date.now()): Promise<void> {
    await this.locks.withExclusiveOperation('dependencies/pool/operations', async () => {
      for (const name of await readdir(this.root).catch(() => [])) {
        if (!/^[a-f0-9]{64}\..+\.tmp$/.test(name)) continue;
        const staging = join(this.root, name);
        const metadata = await lstat(staging).catch(() => undefined);
        if (metadata && now - metadata.mtimeMs > 3_600_000) {
          await rm(staging, { recursive: true, force: true });
        }
      }
      await this.pruneUnlocked();
    });
  }

  private async paths(entry: string): Promise<string[]> {
    const value = JSON.parse(await readFile(join(entry, 'complete.json'), 'utf8'));
    if (!Array.isArray(value.paths) || value.paths.some((path: unknown) => typeof path !== 'string' || isAbsolute(path)
      || path.split(/[\\/]/).some(segment => segment === '..' || segment === '.') || !path.endsWith('node_modules'))) throw new Error('invalid dependency pool paths');
    return value.paths;
  }

  private async pin(entry: string, repoRoot: string): Promise<void> {
    await mkdir(join(entry, 'pins'), { recursive: true });
    await writeFile(join(entry, 'pins', createHash('sha256').update(resolve(repoRoot)).digest('hex')), resolve(repoRoot));
  }

  private async pruneUnlocked(): Promise<void> {
    const entries = await Promise.all((await readdir(this.root)).filter(key => /^[a-f0-9]{64}$/.test(key)).map(async key => {
      const path = join(this.root, key);
      const pins = await readdir(join(path, 'pins'));
      let pinned = false;
      for (const pin of pins) {
        const checkout = await readFile(join(path, 'pins', pin), 'utf8');
        if (await exists(checkout)) pinned = true;
        else await rm(join(path, 'pins', pin));
      }
      return { path, pinned, bytes: await directoryBytes(path), used: (await lstat(path)).mtimeMs };
    }));
    let total = entries.reduce((size, entry) => size + entry.bytes, 0);
    for (const entry of entries.sort((left, right) => left.used - right.used)) {
      if (total <= this.maxBytes) break;
      if (!entry.pinned) { await rm(entry.path, { recursive: true }); total -= entry.bytes; }
    }
  }
}
