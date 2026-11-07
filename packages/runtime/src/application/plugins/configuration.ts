import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { load } from 'js-yaml';
import { Ajv } from 'ajv';
import { z } from 'zod';
import { validatePluginId, type PluginConfigSchema, type PluginConfigValue } from '../../plugin-sdk/profile.js';

const configValue: z.ZodType<PluginConfigValue> = z.lazy(() => z.union([
  z.string(), z.number().finite(), z.boolean(), z.null(), z.array(configValue), z.record(configValue),
]));

const entrySchema = z.object({
  id: z.string().superRefine((id, context) => {
    try { validatePluginId(id); }
    catch { context.addIssue({ code: 'custom', message: 'invalid plugin ID' }); }
  }),
  enabled: z.boolean().optional(),
  builtin: z.boolean().optional(),
  config: z.record(configValue).optional(),
}).passthrough();

export interface InstalledPluginEntry {
  readonly id: string;
  readonly enabled?: boolean;
  readonly builtin?: boolean;
  readonly config?: { readonly [key: string]: PluginConfigValue };
  readonly [key: string]: unknown;
}

export interface PluginConfiguration {
  plugins: InstalledPluginEntry[];
  [key: string]: unknown;
}

export function pluginConfigurationPath(homeDir = homedir()): string {
  return join(homeDir, '.afk', 'plugins.yml');
}

export function readPluginConfiguration(homeDir = homedir()): PluginConfiguration {
  const path = pluginConfigurationPath(homeDir);
  if (!existsSync(path)) return { plugins: [] };
  let parsed: unknown;
  try { parsed = load(readFileSync(path, 'utf8')); }
  catch { throw new Error('Plugin configuration could not be read as valid YAML'); }
  if (parsed === undefined || parsed === null) return { plugins: [] };
  const result = z.object({ plugins: z.array(entrySchema).default([]) }).passthrough().safeParse(parsed);
  if (!result.success) throw new Error(`Invalid plugin configuration: ${result.error.issues.map(issue => issue.path.join('.')).join(', ')}`);
  return result.data;
}

export function validatePluginConfig(schema: PluginConfigSchema | undefined, value: unknown): void {
  if (!schema) return;
  const validator = new Ajv({ allErrors: true, strict: false, validateFormats: false }).compile(schema);
  if (!validator(value)) {
    throw new Error(`Invalid plugin settings: ${(validator.errors ?? []).map(error => `${error.instancePath || '/'} (${error.keyword})`).join(', ')}`);
  }
}
