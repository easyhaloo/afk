export type Capability =
  | 'event-store'
  | 'evidence-store'
  | 'tracer'
  | 'metrics'
  | 'work-catalog'
  | 'lease'
  | 'workspace'
  | 'sandbox'
  | 'agent-runtime'
  | 'verification'
  | 'change'
  | 'policy';

export interface PluginManifest {
  id: string;
  apiVersion: 1;
  provides: readonly Capability[];
  requires?: readonly Capability[];
  configSchema?: Readonly<Record<string, unknown>>;
  trusted: true;
}

export interface ProfileDefinition {
  id: string;
  plugins: readonly string[];
  requiredCapabilities: readonly Capability[];
}

export interface ResolvedProfile {
  id: string;
  manifests: readonly PluginManifest[];
  capabilities: ReadonlyMap<Capability, PluginManifest>;
}

export function resolveProfile(profile: ProfileDefinition, manifests: readonly PluginManifest[]): ResolvedProfile {
  const selected = profile.plugins.map(id => {
    const manifest = manifests.find(candidate => candidate.id === id);
    if (!manifest) throw new Error(`profile '${profile.id}' references unknown plugin '${id}'`);
    if (manifest.apiVersion !== 1 || !manifest.trusted) throw new Error(`plugin '${id}' is not compatible with the trusted plugin API`);
    return manifest;
  });

  const capabilities = new Map<Capability, PluginManifest>();
  for (const manifest of selected) {
    for (const capability of manifest.provides) {
      const existing = capabilities.get(capability);
      if (existing) throw new Error(`profile '${profile.id}' has duplicate '${capability}' providers: '${existing.id}' and '${manifest.id}'`);
      capabilities.set(capability, manifest);
    }
  }
  for (const required of profile.requiredCapabilities) {
    if (!capabilities.has(required)) throw new Error(`profile '${profile.id}' does not provide required capability '${required}'`);
  }
  for (const manifest of selected) {
    for (const required of manifest.requires ?? []) {
      if (!capabilities.has(required)) throw new Error(`plugin '${manifest.id}' requires missing capability '${required}'`);
    }
  }
  return { id: profile.id, manifests: selected, capabilities };
}
