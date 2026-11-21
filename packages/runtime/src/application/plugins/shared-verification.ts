import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { parseCanonicalProject } from '../../domain/work-item/identity.js';
import type { VerificationProvider } from '../../plugin-sdk/capabilities.js';
import type { InstalledPluginRecord } from './manager.js';
import type { PluginConfiguration } from './configuration.js';

const text = z.string().trim().min(1).refine(value => !/[\0\r\n]/.test(value));
const effect = z.enum(['allow', 'deny']);
const integrity = z.string().regex(/^sha256-[A-Za-z0-9+/]{43}=$/);
const grant = z.object({
  project: text.refine(value => {
    try { parseCanonicalProject(value); return !value.includes('*'); } catch { return false; }
  }),
  workspace: text.refine(isAbsolute), plugin: text, version: text, entry: text,
  integrity, treeIntegrity: integrity.optional(),
}).strict();

export const complianceSettings = z.object({
  rules: z.array(z.object({ id: text, effect, actions: z.array(text).min(1).optional(),
    when: z.record(z.union([z.string(), z.number().finite(), z.boolean()])).optional(), reason: text.optional() }).strict()).min(1),
  defaultEffect: effect.optional(), sharedVerification: z.array(grant).optional(),
}).strict();

export function sharedVerificationProject(config: PluginConfiguration, record: InstalledPluginRecord, workspace: string): string | undefined {
  const local = config.plugins.find(entry => entry.id === 'policy.compliance-policy' && entry.builtin && entry.enabled !== false);
  const policy = complianceSettings.safeParse(local?.config);
  if (!policy.success || !record.treeIntegrity) return undefined;
  const matching = policy.data.sharedVerification?.filter(item => item.workspace === workspace && item.plugin === record.id &&
    item.version === record.version && item.entry === record.entry && item.integrity === record.integrity && item.treeIntegrity === record.treeIntegrity);
  return matching?.length === 1 ? matching[0]!.project : undefined;
}

export function scopedVerifier(provider: VerificationProvider & {
  version?: string; source?: string; sourceDigest?: string; readToolDescription?(project: string): Promise<unknown>;
}, permits: (...targets: string[]) => Promise<boolean>) {
  const authorize = async (...targets: string[]) => {
    if (!await permits(...targets)) throw new Error('Shared verification project authorization denied');
  };
  return {
    id: provider.id, capabilities: provider.capabilities, version: provider.version, source: provider.source, sourceDigest: provider.sourceDigest,
    health: provider.health && (async (...args: Parameters<NonNullable<typeof provider.health>>) => { await authorize(); return provider.health!(...args); }),
    doctor: provider.doctor && (async (...args: Parameters<NonNullable<typeof provider.doctor>>) => { await authorize(); return provider.doctor!(...args); }),
    readToolDescription: provider.readToolDescription && (async (project: string) => await permits(project) ? provider.readToolDescription!(project) : undefined),
    async verify(...args: Parameters<VerificationProvider['verify']>) {
      await authorize(args[0].target);
      return provider.verify(...args);
    },
  };
}
