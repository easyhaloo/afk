import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { simpleGit } from 'simple-git';
import { FilesystemClaimLock } from '../../domain/backlog/claim.js';
import { resolveWorkspaceRoot } from '../../shared/workspace-paths.js';

export class RepositoryStore {
  private readonly root: string;
  private readonly locks: FilesystemClaimLock;

  constructor(root = join(resolveWorkspaceRoot(), 'repos')) {
    this.root = resolve(root);
    this.locks = new FilesystemClaimLock(join(this.root, '.locks'), { gateTimeoutMs: 120_000, gateRetryMs: 50 });
  }

  async ensureCheckout(url: string, repoRoot: string, baseBranch: string): Promise<void> {
    const remote = new URL(url);
    const project = remote.pathname.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '');
    if (!['http:', 'https:'].includes(remote.protocol) || remote.username || remote.password || remote.search || remote.hash || !project) {
      throw new Error('invalid repository store remote');
    }
    const identity = remote.hostname === 'github.com' ? project.toLowerCase() : project;
    const segments = [remote.host, ...identity.split('/')];
    if (segments.some(segment => !segment || segment === '.' || segment === '..')) {
      throw new Error('invalid repository store identity');
    }
    const bareRoot = join(this.root, ...segments.map(encodeURIComponent), 'bare.git');
    await this.exclusive(bareRoot, async () => {
      await this.ensureDirectories(dirname(bareRoot));
      const metadata = await fs.lstat(bareRoot).catch(error => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
      });
      if (!metadata) {
        const temporary = `${bareRoot}.${randomUUID()}.tmp`;
        try {
          await simpleGit().clone(url, temporary, ['--bare']);
          await fs.rename(temporary, bareRoot);
        } finally {
          await fs.rm(temporary, { recursive: true, force: true });
        }
      } else if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
        throw new Error(`repository store must be a non-symlink directory: ${bareRoot}`);
      }
      const git = simpleGit(bareRoot);
      const origin = (await git.raw(['config', '--get', 'remote.origin.url'])).trim();
      const matches = remote.hostname === 'github.com' ? origin.toLowerCase() === url.toLowerCase() : origin === url;
      if (!matches) {
        throw new Error('repository store origin does not match requested remote');
      }
      await git.raw(['config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*']);
      await git.raw(['fetch', 'origin', `+refs/heads/${baseBranch}:refs/remotes/origin/${baseBranch}`]);
      await fs.mkdir(dirname(repoRoot), { recursive: true });
      await git.raw(['worktree', 'add', '--detach', repoRoot, `refs/remotes/origin/${baseBranch}`]);
    });
  }

  async ownsCheckout(repoRoot: string): Promise<boolean> {
    const commonRoot = await this.commonDirectory(repoRoot);
    return commonRoot !== undefined && this.contains(commonRoot);
  }

  async withCheckoutLock<Result>(repoRoot: string, operation: () => Promise<Result>): Promise<Result> {
    const commonRoot = await this.commonDirectory(repoRoot);
    return commonRoot && this.contains(commonRoot) ? this.exclusive(commonRoot, operation) : operation();
  }

  async removeCheckout(repoRoot: string): Promise<void> {
    const commonRoot = await this.commonDirectory(repoRoot);
    if (!commonRoot) return;
    if (!this.contains(commonRoot)) throw new Error('refusing to remove a checkout outside the repository store');
    await this.exclusive(commonRoot, async () => {
      const git = simpleGit(commonRoot);
      const entries = (await git.raw(['worktree', 'list', '--porcelain', '-z'])).split('\0');
      const paths = entries.filter(entry => entry.startsWith('worktree ')).map(entry => entry.slice(9));
      const target = await fs.realpath(repoRoot);
      for (const path of paths.filter(path => path === target || path.startsWith(`${target}${sep}`)).sort((left, right) => right.length - left.length)) {
        await git.raw(['worktree', 'remove', '--force', path]);
      }
    });
  }

  private async commonDirectory(repoRoot: string): Promise<string | undefined> {
    try {
      const commonRoot = (await simpleGit(repoRoot).raw(['rev-parse', '--git-common-dir'])).trim();
      const canonical = await fs.realpath(resolve(repoRoot, commonRoot));
      const storeRoot = await fs.realpath(this.root).catch(error => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return this.root;
        throw error;
      });
      const location = relative(storeRoot, canonical);
      return resolve(this.root, location);
    } catch (error) {
      const metadata = await fs.lstat(repoRoot).catch(missing => {
        if ((missing as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw missing;
      });
      if (!metadata || (metadata.isDirectory() && (await fs.readdir(repoRoot)).length === 0)) return undefined;
      throw error;
    }
  }

  private contains(path: string): boolean {
    const location = relative(this.root, path);
    return location !== '' && location !== '..' && !location.startsWith(`..${sep}`) && !isAbsolute(location);
  }

  private exclusive<Result>(bareRoot: string, operation: () => Promise<Result>): Promise<Result> {
    const key = createHash('sha256').update(bareRoot).digest('hex');
    return this.locks.withExclusiveOperation(`repositories/${key}/git`, operation);
  }

  private async ensureDirectories(directory: string): Promise<void> {
    let current = this.root;
    for (const segment of ['', ...relative(this.root, directory).split(sep)]) {
      current = join(current, segment);
      await fs.mkdir(current).catch(error => {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      });
      const metadata = await fs.lstat(current);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
        throw new Error(`repository store must be a non-symlink directory: ${current}`);
      }
    }
  }
}
