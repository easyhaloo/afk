import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dump } from 'js-yaml';
import { validateManifest, validatePluginId, type PluginManifest } from '../../plugin-sdk/profile.js';
import { pluginConfigurationPath, readPluginConfiguration, validatePluginConfig, type PluginConfiguration } from './configuration.js';

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

interface PluginDependencyState {
  readonly manifests: ReadonlyMap<string, PluginManifest>;
  readonly credentials: ReadonlySet<string>;
  readonly opaqueCredentials: ReadonlySet<string>;
  readonly dependencies: ReadonlyMap<string, readonly string[]>;
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

  private configuration(): PluginConfiguration {
    try {
      const configuration = readPluginConfiguration(this.homeDir);
      if (new Set(configuration.plugins.map(entry => entry.id)).size !== configuration.plugins.length) throw new Error();
      return configuration;
    } catch { throw new Error('Invalid plugin configuration'); }
  }

  private async installed(id: string, verifyEntry = true): Promise<InstalledPluginRecord | undefined> {
    try {
      const directory = join(this.directory, id);
      const record = await readInstalledPlugin(directory);
      if (!record) return undefined;
      validateManifest(record.manifest);
      if (record.id !== id || record.version !== record.manifest.version) throw new Error();
      if (verifyEntry) await resolveInstalledPluginEntry(directory, record);
      return record;
    } catch { throw new Error(`Invalid installed plugin metadata for '${id}'; reinstall the plugin`); }
  }

  private validateSettings(manifest: PluginManifest, config: unknown): void {
    try { validatePluginConfig(manifest.configSchema, config); }
    catch { throw new Error(`Invalid plugin settings for '${manifest.id}'`); }
  }

  private async manifests(configuration: PluginConfiguration, replacement?: PluginManifest, repairId?: string): Promise<PluginDependencyState> {
    const { builtinPluginManifests } = await import('./builtin-manifests.js');
    const defaults = new Map(builtinPluginManifests(this.homeDir, configuration.integrations).map(manifest => [manifest.id, manifest]));
    const manifests = new Map<string, PluginManifest>();
    const credentials = new Set([...defaults.values()].filter(manifest => manifest.provides.includes('credential.provider')).map(manifest => manifest.id));
    const opaqueCredentials = new Set<string>();
    const dependencies = new Map<string, readonly string[]>();
    for (const entry of configuration.plugins) {
      const builtin = defaults.get(entry.id);
      defaults.delete(entry.id);
      credentials.delete(entry.id);
      if (entry.enabled === false) continue;
      let manifest: PluginManifest | undefined;
      if (entry.builtin) {
        try {
          if (entry.config === undefined) manifest = builtin;
          else {
            const { createConfiguredPlugins, getConfiguredCredentialDependencies } = await import('./configured.js');
            const [plugin] = await createConfiguredPlugins({ configurations: [entry], homeDir: this.homeDir, onTrigger: async () => {} });
            manifest = plugin.manifest;
            dependencies.set(entry.id, getConfiguredCredentialDependencies(plugin));
          }
        } catch { throw new Error(`Invalid builtin plugin configuration for '${entry.id}'`); }
      } else {
        manifest = replacement?.id === entry.id ? replacement : (await this.installed(entry.id, entry.id !== repairId))?.manifest;
        if (manifest) {
          try { validatePluginConfig(manifest.configSchema, entry.config ?? {}); }
          catch (error) {
            if (error instanceof Error && error.message.startsWith('Invalid plugin settings:')) continue;
            throw new Error(`Invalid installed plugin metadata for '${entry.id}'`);
          }
        }
      }
      if (!manifest) throw new Error(`Plugin metadata is unavailable for '${entry.id}'`);
      if (entry.builtin) {
        defaults.set(entry.id, manifest);
        if (manifest.provides.includes('credential.provider')) credentials.add(entry.id);
      } else {
        manifests.set(entry.id, manifest);
        if (manifest.provides.includes('credential.provider')) opaqueCredentials.add(entry.id);
      }
    }
    return { manifests: new Map([...manifests, ...defaults]), credentials, opaqueCredentials, dependencies };
  }

  private availablePlugins(state: PluginDependencyState, knownCredentials: ReadonlySet<string>): Set<string> {
    const loaded: PluginManifest[] = [];
    const capabilities = new Set<string>();
    const credentials = new Set<string>();
    let pending = [...state.manifests.values()];
    while (pending.length) {
      const deferred: PluginManifest[] = [];
      for (const manifest of pending) {
        if (manifest.requires?.some(capability => !capabilities.has(capability))) { deferred.push(manifest); continue; }
        if (state.dependencies.get(manifest.id)?.some(name => !credentials.has(name) &&
          (knownCredentials.has(name) || !loaded.some(provider => state.opaqueCredentials.has(provider.id))))) { deferred.push(manifest); continue; }
        if (loaded.some(other => manifest.conflicts?.some(conflict => conflict === other.id || other.provides.includes(conflict)) ||
          other.conflicts?.some(conflict => conflict === manifest.id || manifest.provides.includes(conflict)))) continue;
        loaded.push(manifest);
        if (state.credentials.has(manifest.id)) credentials.add(manifest.id);
        for (const capability of manifest.provides) capabilities.add(capability);
      }
      if (deferred.length === pending.length) break;
      pending = deferred;
    }
    return new Set(loaded.map(manifest => manifest.id));
  }

  private async protectDependencies(id: string, configuration: PluginConfiguration, next: PluginConfiguration, replacement?: PluginManifest): Promise<void> {
    const previous = await this.manifests(configuration, undefined, replacement?.id);
    const manifests = await this.manifests(next, replacement);
    const knownCredentials = new Set([...previous.credentials, ...manifests.credentials]);
    const before = this.availablePlugins(previous, knownCredentials);
    const after = this.availablePlugins(manifests, knownCredentials);
    const opaqueChanged = previous.opaqueCredentials.has(id) && (!manifests.opaqueCredentials.has(id) || replacement !== undefined ||
      JSON.stringify(configuration.plugins.find(entry => entry.id === id)?.config) !== JSON.stringify(next.plugins.find(entry => entry.id === id)?.config));
    const dependent = [...previous.manifests.values()].find(manifest => manifest.id !== id &&
      (manifest.requires?.length || previous.dependencies.get(manifest.id)?.length) && before.has(manifest.id) && manifests.manifests.has(manifest.id) &&
      (!after.has(manifest.id) || (opaqueChanged && previous.dependencies.get(manifest.id)?.some(name => !knownCredentials.has(name)))));
    if (dependent) throw new Error(`Plugin '${id}' is required by '${dependent.id}'`);
  }

  async install(source: string): Promise<InstalledPluginRecord> {
    return this.locked(async () => {
      const configuration = this.configuration();
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
        let metadata: PluginManifest & { entry?: string };
        try {
          metadata = JSON.parse(await fs.readFile(join(packageRoot, 'plugin.json'), 'utf8')) as typeof metadata;
          validateManifest(metadata);
        } catch { throw new Error('Invalid plugin manifest'); }
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
        const existing = configuration.plugins.find(entry => entry.id === metadata.id);
        if (existing?.config !== undefined) this.validateSettings(metadata, existing.config);
        const setting = { ...existing, id: metadata.id, enabled: true, builtin: false };
        const next = { ...configuration, plugins: existing ? configuration.plugins.map(entry => entry.id === metadata.id ? setting : entry) : [...configuration.plugins, setting] };
        await this.protectDependencies(metadata.id, configuration, next, metadata);
        destination = join(this.directory, metadata.id);
        if (await fs.stat(destination).then(() => true, () => false)) {
          backup = join(this.directory, `.backup-${randomUUID()}`);
          await fs.rename(destination, backup);
        }
        await fs.rename(stage, destination);
        published = true;
        await atomicWrite(pluginConfigurationPath(this.homeDir), dump(next));
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
    const configuration = this.configuration();
    const existing = configuration.plugins.find(entry => entry.id === id);
    const installed = await this.installed(id);
    if (enabled && !existing?.builtin && !builtin && !installed) throw new Error(`Plugin '${id}' is not installed`);
    const setting = { ...existing, id, enabled, builtin: existing?.builtin ?? (installed ? false : builtin) };
    if (enabled && !setting.builtin && installed) this.validateSettings(installed.manifest, existing?.config ?? {});
    const next = { ...configuration, plugins: existing ? configuration.plugins.map(entry => entry.id === id ? setting : entry) : [...configuration.plugins, setting] };
    await this.protectDependencies(id, configuration, next);
    await atomicWrite(pluginConfigurationPath(this.homeDir), dump(next));
  }

  async configure(id: string, config: { readonly [key: string]: import('../../plugin-sdk/profile.js').PluginConfigValue }, builtin = false, action?: string): Promise<void> {
    validatePluginId(id);
    if (action !== undefined && (!action.trim() || action.includes('\0'))) throw new Error('Invalid trigger action name');
    await this.locked(async () => {
      const configuration = this.configuration();
      const installed = builtin ? undefined : await this.installed(id);
      if (!builtin && !installed) throw new Error(`Plugin '${id}' is not installed`);
      if (builtin) {
        try {
          const { createConfiguredPlugins } = await import('./configured.js');
          await createConfiguredPlugins({ configurations: [{ id, config }], homeDir: this.homeDir, onTrigger: async () => {} });
        } catch { throw new Error(`Invalid plugin settings for '${id}'`); }
      }
      if (installed) this.validateSettings(installed.manifest, config);
      const existing = configuration.plugins.find(entry => entry.id === id);
      const entry = { ...existing, id, enabled: existing?.enabled ?? true, builtin, config, ...(action === undefined ? {} : { action }) };
      const next = { ...configuration, plugins: [...configuration.plugins.filter(candidate => candidate.id !== id), entry] };
      await this.protectDependencies(id, configuration, next);
      await atomicWrite(pluginConfigurationPath(this.homeDir), dump(next));
    });
  }

  async remove(id: string): Promise<void> {
    validatePluginId(id);
    await this.locked(async () => {
      const directory = join(this.directory, id);
      if (!await this.installed(id)) throw new Error(`Plugin '${id}' is not installed`);
      await this.setEnabledUnlocked(id, false);
      await fs.rm(directory, { recursive: true, force: true });
    });
  }
}
