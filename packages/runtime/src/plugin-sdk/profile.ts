import { z } from 'zod';

const externalToolSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/),
  command: z.string().max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
  location: z.enum(['host', 'backend']),
  version: z.object({
    args: z.array(z.string().max(256).refine(value => !/[\x00-\x1f\x7f]/.test(value))).min(1).max(16).readonly(),
    minimum: z.string().regex(/^(?:0|[1-9]\d{0,5})\.(?:0|[1-9]\d{0,5})\.(?:0|[1-9]\d{0,5})$/).optional(),
  }).strict().readonly().optional(),
  platforms: z.array(z.enum(['aix', 'darwin', 'freebsd', 'linux', 'openbsd', 'sunos', 'win32', 'android', 'haiku'])).min(1).refine(values => new Set(values).size === values.length).readonly().optional(),
  architectures: z.array(z.enum(['arm', 'arm64', 'ia32', 'loong64', 'mips', 'mipsel', 'ppc', 'ppc64', 'riscv64', 's390', 's390x', 'x64'])).min(1).refine(values => new Set(values).size === values.length).readonly().optional(),
  source: z.object({ url: z.string().max(2048).url().refine(value => {
    if (/[\x00-\x20\x7f]/.test(value)) return false;
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash;
    } catch { return false; }
  }) }).strict().readonly(),
  optional: z.boolean().optional(),
}).strict().readonly();

export type ExternalToolDependency = z.infer<typeof externalToolSchema>;

const externalToolsSchema = z.array(externalToolSchema).max(64).refine(tools => new Set(tools.map(tool => tool.id)).size === tools.length);

export const CORE_CAPABILITIES = [
  'agent.provider',
  'sandbox.provider',
  'tracker.provider',
  'tracker.issue',
  'backlog.provider',
  'host.connection',
  'verification.provider',
  'notification.provider',
  'trigger.provider',
  'context.provider',
  'credential.provider',
  'artifact.provider',
  'repository.provider',
  'policy.provider',
  'observability.provider',
  'workflow.lifecycle',
  'workflow.template',
  'workflow.action',
  'surface.cli',
  'surface.tui',
  'surface.desktop',
  'observe.event-store',
  'observe.evidence',
  'observe.tracing',
  'observe.metrics',
] as const;

export type Capability =
  | typeof CORE_CAPABILITIES[number]
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
  | 'policy'
  | 'host-connection'
  | (string & {});

export type PluginConfigValue = string | number | boolean | null | readonly PluginConfigValue[] | { readonly [key: string]: PluginConfigValue };

export interface PluginConfigSchema {
  readonly type?: 'null' | 'boolean' | 'object' | 'array' | 'number' | 'integer' | 'string';
  readonly title?: string;
  readonly description?: string;
  readonly properties?: { readonly [name: string]: PluginConfigSchema };
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean | PluginConfigSchema;
  readonly items?: PluginConfigSchema;
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly uniqueItems?: boolean;
  readonly enum?: readonly PluginConfigValue[];
  readonly default?: PluginConfigValue;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly pattern?: string;
  readonly format?: string;
  readonly $ref?: string;
  readonly $defs?: { readonly [name: string]: PluginConfigSchema };
  readonly allOf?: readonly PluginConfigSchema[];
  readonly anyOf?: readonly PluginConfigSchema[];
  readonly oneOf?: readonly PluginConfigSchema[];
  readonly not?: PluginConfigSchema;
}

export interface PluginManifest {
  readonly id: string;
  readonly version: string;
  readonly apiVersion: 1;
  readonly provides: readonly Capability[];
  readonly requires?: readonly Capability[];
  readonly conflicts?: readonly string[];
  readonly configSchema?: PluginConfigSchema;
  readonly externalTools?: readonly ExternalToolDependency[];
  readonly trusted: boolean;
}

export interface ProfileDefinition {
  id: string;
  plugins: readonly string[];
  requiredCapabilities: readonly Capability[];
}

export interface ResolvedProfile {
  id: string;
  manifests: readonly PluginManifest[];
  capabilities: ReadonlyMap<Capability, readonly PluginManifest[]>;
}

export function resolveProfile(profile: ProfileDefinition, manifests: readonly PluginManifest[]): ResolvedProfile {
  const selected = profile.plugins.map(id => {
    const manifest = manifests.find(candidate => candidate.id === id);
    if (!manifest) throw new Error(`profile '${profile.id}' references unknown plugin '${id}'`);
    validateManifest(manifest);
    if (!manifest.trusted) throw new Error(`plugin '${id}' is not trusted`);
    return manifest;
  });

  const selectedIds = new Set<string>();
  for (const manifest of selected) {
    if (selectedIds.has(manifest.id)) throw new Error(`profile '${profile.id}' selects plugin '${manifest.id}' more than once`);
    selectedIds.add(manifest.id);
  }

  const capabilities = new Map<Capability, PluginManifest[]>();
  for (const manifest of selected) {
    for (const capability of manifest.provides) {
      capabilities.set(capability, [...capabilities.get(capability) ?? [], manifest]);
    }
  }
  for (const manifest of selected) {
    for (const conflict of manifest.conflicts ?? []) {
      if (selectedIds.has(conflict) || capabilities.has(conflict)) {
        throw new Error(`plugin '${manifest.id}' conflicts with '${conflict}'`);
      }
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

export function validateManifest(manifest: PluginManifest): void {
  if (!manifest || typeof manifest !== 'object') throw new Error('invalid plugin manifest');
  validatePluginId(manifest.id);
  if (typeof manifest.version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(manifest.version)) throw new Error(`plugin '${manifest.id}' has an invalid version`);
  if (manifest.apiVersion !== 1 || manifest.trusted !== true) {
    throw new Error(`plugin '${manifest.id}' is not compatible with the trusted plugin API`);
  }
  for (const field of ['provides', 'requires', 'conflicts'] as const) {
    const entries = manifest[field];
    if ((field === 'provides' || entries !== undefined) && (!Array.isArray(entries) || entries.some(entry => typeof entry !== 'string') || new Set(entries).size !== entries.length)) {
      throw new Error(`plugin '${manifest.id}' has invalid ${field}`);
    }
  }
  for (const capability of manifest.provides) validateIdentifier(capability, 'capability');
  for (const capability of manifest.requires ?? []) validateIdentifier(capability, 'capability');
  for (const conflict of manifest.conflicts ?? []) validateIdentifier(conflict, 'plugin conflict');
  if (manifest.externalTools !== undefined && !externalToolsSchema.safeParse(manifest.externalTools).success) {
    throw new Error(`plugin '${manifest.id}' has invalid externalTools`);
  }
}

export function validatePluginId(id: string): void {
  if (typeof id !== 'string' || !/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)+$/.test(id) || /^(?:afk[-.])/.test(id)) {
    throw new Error(`invalid plugin id '${id}'`);
  }
}

function validateIdentifier(value: string, kind: string): void {
  if (!/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/.test(value)) throw new Error(`invalid ${kind} '${value}'`);
}
