import { homedir } from 'node:os';
import { join } from 'node:path';
import { validateManifest, validatePluginId, type PluginManifest, type ExternalToolDependency } from '../../plugin-sdk/profile.js';
import { readPluginConfiguration, validatePluginConfig, type PluginConfiguration } from './configuration.js';
import { readInstalledPlugin } from './manager.js';
import { builtinPluginManifests, builtinExternalTools, configuredExternalTools, type UnsupportedToolBinding } from './builtin-manifests.js';
import { inspectConfiguredPlugins } from './configured.js';
import { diagnoseExternalTools, listExternalTools, type ExternalToolDiagnostic, type ExternalToolDiagnosticOptions } from './external-tools.js';

export interface PluginInventoryEntry {
  readonly id: string;
  readonly builtin: boolean;
  readonly enabled: boolean;
  readonly configuration: 'default' | 'valid' | 'invalid' | 'unavailable';
  readonly manifest?: PluginManifest;
  readonly capabilities: readonly string[];
  readonly credentialDependencies: readonly string[];
  readonly externalTools: readonly (ExternalToolDependency | UnsupportedToolBinding)[];
  readonly diagnostics: readonly { readonly pluginId: string; readonly severity: 'error'; readonly code: string; readonly message: string }[];
}

export async function listPluginInventory(options: { readonly homeDir?: string; readonly configuration?: PluginConfiguration } = {}): Promise<readonly PluginInventoryEntry[]> {
  const homeDir = options.homeDir ?? homedir();
  const configuration = options.configuration ?? readPluginConfiguration(homeDir);
  const defaults = new Map(builtinPluginManifests(homeDir, configuration.integrations).map(manifest => [manifest.id, manifest]));
  const rows = new Map<string, PluginInventoryEntry>();
  for (const manifest of defaults.values()) rows.set(manifest.id, { id: manifest.id, builtin: true, enabled: true, configuration: 'default',
    manifest, capabilities: manifest.provides, credentialDependencies: [], externalTools: manifest.externalTools ?? [], diagnostics: [] });
  const seen = new Set<string>();
  for (const entry of configuration.plugins) {
    validatePluginId(entry.id);
    if (seen.has(entry.id)) throw new Error('Duplicate plugin configuration');
    seen.add(entry.id);
    let manifest: PluginManifest | undefined;
    let credentialDependencies: readonly string[] = [];
    let tools: PluginInventoryEntry['externalTools'] = [];
    let state: PluginInventoryEntry['configuration'] = 'valid';
    let code = 'config.invalid';
    try {
      if (entry.builtin) {
        if (entry.config === undefined) manifest = defaults.get(entry.id);
        else {
          const [metadata] = inspectConfiguredPlugins({ configurations: [entry] });
          manifest = metadata.manifest;
          credentialDependencies = metadata.credentialDependencies;
        }
        if (!manifest) throw new Error('Unknown builtin');
        const projection = configuredExternalTools(entry.id, entry.config);
        manifest = { ...manifest, externalTools: projection.declarations };
        tools = [...projection.declarations, ...projection.unsupported];
      } else {
        const record = await readInstalledPlugin(join(homeDir, '.afk', 'plugins', entry.id));
        if (!record) { state = 'unavailable'; code = 'plugin.not-installed'; throw new Error('Missing metadata'); }
        validateManifest(record.manifest);
        if (record.id !== entry.id || record.manifest.id !== entry.id || record.version !== record.manifest.version) throw new Error('Invalid metadata');
        manifest = record.manifest;
        validatePluginConfig(manifest.configSchema, entry.config ?? {});
        tools = manifest.externalTools ?? [];
      }
    } catch {
      if (state !== 'unavailable') state = 'invalid';
      manifest = undefined; tools = []; credentialDependencies = [];
    }
    rows.set(entry.id, { id: entry.id, builtin: entry.builtin === true, enabled: entry.enabled !== false, configuration: state,
      manifest, capabilities: manifest?.provides ?? [], credentialDependencies, externalTools: tools,
      diagnostics: state === 'valid' ? [] : [{ pluginId: entry.id, severity: 'error', code, message: 'Plugin metadata or configuration shape is invalid or unavailable' }] });
  }
  const active = [...rows.values()].filter(row => row.enabled && row.manifest);
  const available = new Set<string>();
  const capabilities = new Set<string>();
  const credentials = new Set<string>();
  const knownCredentials = new Set([...rows.values()].filter(row => row.builtin && row.capabilities.includes('credential.provider')).map(row => row.id));
  let opaqueCredentials = false;
  let pending = active;
  while (pending.length) {
    const deferred: PluginInventoryEntry[] = [];
    for (const row of pending) {
      if (row.manifest?.requires?.some(capability => !capabilities.has(capability))
        || row.credentialDependencies.some(name => !credentials.has(name) && (knownCredentials.has(name) || !opaqueCredentials))) {
        deferred.push(row); continue;
      }
      available.add(row.id);
      for (const capability of row.capabilities) capabilities.add(capability);
      if (row.capabilities.includes('credential.provider')) {
        if (row.builtin) credentials.add(row.id);
        else opaqueCredentials = true;
      }
    }
    if (deferred.length === pending.length) break;
    pending = deferred;
  }
  return [...rows.values()].map(row => row.enabled && row.manifest && !available.has(row.id)
    ? { ...row, diagnostics: [...row.diagnostics, { pluginId: row.id, severity: 'error' as const, code: 'config.dependencies', message: 'Required capability or credential dependency is missing or cyclic' }] }
    : row);
}

export async function diagnosePluginInventory(rows: readonly PluginInventoryEntry[], options: Pick<ExternalToolDiagnosticOptions, 'probe' | 'execute' | 'executorLifecycle' | 'timeoutMs' | 'signal'> = {}): Promise<readonly (ExternalToolDiagnostic & { readonly pluginId: string } | UnsupportedToolBinding & { readonly pluginId: string })[]> {
  const timeoutMs = options.timeoutMs ?? 3000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 5000) throw new Error('Invalid external tool timeout');
  const deadline = Date.now() + timeoutMs;
  const results = [];
  for (const row of rows) {
    if (!row.enabled || !row.manifest || row.diagnostics.length) continue;
    const known = row.builtin ? builtinExternalTools(row.id) : [];
    const approvedProbes = known.filter(tool => tool.version).map(tool => ({ command: tool.command, args: tool.version!.args, location: tool.location }));
    const remaining = deadline - Date.now();
    const diagnostics = options.probe === true && remaining <= 0
      ? listExternalTools(row.manifest).map(tool => ({ id: tool.id, location: tool.location, status: 'unknown' as const,
        reason: tool.location === 'backend' ? 'backend-required' as const : options.signal?.aborted ? 'cancelled' as const : 'timeout' as const }))
      : await diagnoseExternalTools(row.manifest, { probe: options.probe, execute: options.execute,
        executorLifecycle: options.executorLifecycle, timeoutMs: Math.max(1, remaining), signal: options.signal, approvedProbes });
    results.push(...diagnostics.map(result => ({ ...result, pluginId: row.id })),
      ...row.externalTools.filter((tool): tool is UnsupportedToolBinding => 'status' in tool).map(tool => ({ ...tool, pluginId: row.id })));
  }
  return results;
}
