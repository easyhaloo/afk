import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dump } from 'js-yaml';
import { validateManifest, validatePluginId, type PluginManifest } from '../../plugin-sdk/profile.js';
import { pluginConfigurationPath, readPluginConfiguration, validatePluginConfig } from './configuration.js';

export interface InstalledPluginRecord {
  readonly id: string;
  readonly version: string;
  readonly source: string;
  readonly entry: string;
  readonly integrity: string;
  readonly installedAt: string;
  readonly manifest: PluginManifest;
}

export interface PluginManagerOptions {
  readonly homeDir?: string;
  readonly runNpm?: (args: readonly string[], cwd: string) => Promise<void>;
}

async function atomicWrite(path: string, value: string): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, value, { mode: 0o600 });
    await fs.rename(temporary, path);
  } finally { await fs.rm(temporary, { force: true }); }
}

function inside(root: string, path: string): boolean {
  return path === root || path.startsWith(root + sep);
}

export async function readInstalledPlugin(directory: string): Promise<InstalledPluginRecord | undefined> {
  try { return JSON.parse(await fs.readFile(join(directory, 'install.json'), 'utf8')) as InstalledPluginRecord; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

export async function resolveInstalledPluginEntry(directory: string, record: InstalledPluginRecord): Promise<string> {
  validateManifest(record.manifest);
  if (record.manifest.id !== record.id || isAbsolute(record.entry)) throw new Error('Invalid installed plugin record');
  const root = await fs.realpath(directory);
  const entry = await fs.realpath(resolve(directory, record.entry));
  if (!inside(root, entry)) throw new Error('Plugin entry escapes its installation directory');
  const digest = `sha256-${createHash('sha256').update(await fs.readFile(entry)).digest('base64')}`;
  if (digest !== record.integrity) throw new Error('Plugin entry integrity check failed; reinstall the plugin');
  return entry;
}

const runNpm: NonNullable<PluginManagerOptions['runNpm']> = (args, cwd) => new Promise((resolveCommand, reject) => {
  execFile('npm', [...args], { cwd, timeout: 180_000, maxBuffer: 4 * 1024 * 1024 }, error => {
    if (error) reject(new Error('Plugin dependency installation failed; the previous installation was preserved'));
    else resolveCommand();
  });
});

export class PluginManager {
  private readonly homeDir: string;
  private readonly directory: string;
  private readonly npm: NonNullable<PluginManagerOptions['runNpm']>;

  constructor(options: PluginManagerOptions = {}) {
    this.homeDir = options.homeDir ?? homedir();
    this.directory = join(this.homeDir, '.afk', 'plugins');
    this.npm = options.runNpm ?? runNpm;
  }

  private async locked<T>(operation: () => Promise<T>): Promise<T> {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const lockPath = join(this.directory, '.manager.lock');
    let lock;
    try { lock = await fs.open(lockPath, 'wx', 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('Another plugin operation holds .manager.lock; retry after it finishes');
      throw error;
    }
    try { return await operation(); }
    finally { await lock.close(); await fs.rm(lockPath, { force: true }); }
  }

  async install(source: string): Promise<InstalledPluginRecord> {
    return this.locked(async () => {
      const stage = await fs.mkdtemp(join(this.directory, '.install-'));
      let destination: string | undefined;
      let backup: string | undefined;
      let published = false;
      try {
        const local = resolve(source);
        const isLocal = await fs.stat(local).then(stat => stat.isDirectory(), () => false);
        let packageRoot: string;
        const args = ['install', '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund', '--legacy-peer-deps'];
        if (isLocal) {
          if (inside(await fs.realpath(local), await fs.realpath(stage))) throw new Error('Plugin source contains its installation directory');
          packageRoot = join(stage, 'package');
          await fs.cp(local, packageRoot, { recursive: true, filter: path => !['node_modules', '.git'].includes(path.split(sep).at(-1) ?? '') });
          const metadata = JSON.parse(await fs.readFile(join(packageRoot, 'package.json'), 'utf8')) as { dependencies?: object; optionalDependencies?: object };
          if (Object.keys(metadata.dependencies ?? {}).length || Object.keys(metadata.optionalDependencies ?? {}).length) await this.npm(args, packageRoot);
        } else {
          if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*(?:@[A-Za-z0-9.*^~+<>=|-]+)?$/.test(source)) {
            throw new Error('Expected a local plugin directory or an npm package specification');
          }
          await fs.writeFile(join(stage, 'package.json'), '{"private":true}');
          await this.npm([...args, '--save-exact', source], stage);
          const metadata = JSON.parse(await fs.readFile(join(stage, 'package.json'), 'utf8')) as { dependencies?: { [name: string]: string } };
          const names = Object.keys(metadata.dependencies ?? {});
          if (names.length !== 1) throw new Error('The package manager did not resolve exactly one plugin package');
          packageRoot = join(stage, 'node_modules', names[0]);
        }
        const metadata = JSON.parse(await fs.readFile(join(packageRoot, 'plugin.json'), 'utf8')) as PluginManifest & { entry?: string };
        validateManifest(metadata);
        const entryPath = metadata.entry ?? 'dist/index.js';
        if (isAbsolute(entryPath)) throw new Error('Plugin entry must be a relative path');
        const root = await fs.realpath(packageRoot);
        const entry = await fs.realpath(resolve(packageRoot, entryPath));
        if (!inside(root, entry) || !(await fs.stat(entry)).isFile()) throw new Error('Plugin entry escapes its package or is not a file');
        await fs.mkdir(join(packageRoot, 'node_modules', '@afk'), { recursive: true });
        const sdkLink = join(packageRoot, 'node_modules', '@afk', 'runtime');
        await fs.rm(sdkLink, { recursive: true, force: true });
        await fs.symlink(fileURLToPath(new URL('../../../', import.meta.url)), sdkLink, 'dir');
        const record: InstalledPluginRecord = {
          id: metadata.id, version: metadata.version, source: isLocal ? local : source,
          entry: relative(await fs.realpath(stage), entry), manifest: metadata,
          integrity: `sha256-${createHash('sha256').update(await fs.readFile(entry)).digest('base64')}`,
          installedAt: new Date().toISOString(),
        };
        await fs.writeFile(join(stage, 'install.json'), JSON.stringify(record, null, 2), { mode: 0o600 });
        destination = join(this.directory, metadata.id);
        if (await fs.stat(destination).then(() => true, () => false)) {
          backup = join(this.directory, `.backup-${randomUUID()}`);
          await fs.rename(destination, backup);
        }
        await fs.rename(stage, destination);
        published = true;
        await this.setEnabledUnlocked(metadata.id, true);
        if (backup) await fs.rm(backup, { recursive: true, force: true });
        return record;
      } catch (error) {
        if (published && destination) await fs.rm(destination, { recursive: true, force: true });
        if (backup && destination) await fs.rename(backup, destination);
        throw error;
      } finally { await fs.rm(stage, { recursive: true, force: true }); }
    });
  }

  async setEnabled(id: string, enabled: boolean, builtin = false): Promise<void> {
    validatePluginId(id);
    await this.locked(() => this.setEnabledUnlocked(id, enabled, builtin));
  }

  private async setEnabledUnlocked(id: string, enabled: boolean, builtin = false): Promise<void> {
    const configuration = readPluginConfiguration(this.homeDir);
    const existing = configuration.plugins.find(entry => entry.id === id);
    const installed = await readInstalledPlugin(join(this.directory, id));
    if (enabled && !existing?.builtin && !builtin && !installed) throw new Error(`Plugin '${id}' is not installed`);
    const setting = { ...existing, id, enabled, ...(installed ? { builtin: false } : builtin ? { builtin: true } : {}) };
    if (existing) configuration.plugins = configuration.plugins.map(entry => entry.id === id ? setting : entry);
    else configuration.plugins.push(setting);
    await atomicWrite(pluginConfigurationPath(this.homeDir), dump(configuration));
  }

  async configure(id: string, config: { readonly [key: string]: import('../../plugin-sdk/profile.js').PluginConfigValue }, builtin = false, action?: string): Promise<void> {
    validatePluginId(id);
    if (action !== undefined && (!action.trim() || action.includes('\0'))) throw new Error('Invalid trigger action name');
    await this.locked(async () => {
      const installed = await readInstalledPlugin(join(this.directory, id));
      if (!builtin && !installed) throw new Error(`Plugin '${id}' is not installed`);
      if (builtin) {
        const { createConfiguredPlugins } = await import('./configured.js');
        await createConfiguredPlugins({ configurations: [{ id, config }], homeDir: this.homeDir, onTrigger: async () => {} });
      }
      validatePluginConfig(installed?.manifest.configSchema, config);
      const configuration = readPluginConfiguration(this.homeDir);
      const existing = configuration.plugins.find(entry => entry.id === id);
      const entry = { ...existing, id, enabled: existing?.enabled ?? true, builtin, config, ...(action === undefined ? {} : { action }) };
      configuration.plugins = [...configuration.plugins.filter(candidate => candidate.id !== id), entry];
      await atomicWrite(pluginConfigurationPath(this.homeDir), dump(configuration));
    });
  }

  async remove(id: string): Promise<void> {
    validatePluginId(id);
    await this.locked(async () => {
      const directory = join(this.directory, id);
      if (!await readInstalledPlugin(directory)) throw new Error(`Plugin '${id}' is not installed`);
      await this.setEnabledUnlocked(id, false);
      await fs.rm(directory, { recursive: true, force: true });
    });
  }
}
