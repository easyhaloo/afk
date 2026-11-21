import { isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import { readPluginConfiguration } from '../plugins/configuration.js';
import { knowledgeConfigurationSchema, type KnowledgeRuntimeOptions } from './knowledge-runtime.js';

const savedPath = z.string().min(1).max(4096)
  .refine(value => isAbsolute(value) && resolve(value) === value && !/[\0\r\n]/.test(value));
const configurationSchema = z.object({
  enabled: z.boolean().optional(),
  knowledge: z.lazy(() => knowledgeConfigurationSchema),
  validation: z.object({ configurationFile: savedPath }).strict(),
}).passthrough();

export function readExperienceKnowledgeConfiguration(homeDir: string): KnowledgeRuntimeOptions | undefined {
  try {
    savedPath.parse(homeDir);
    const entries = readPluginConfiguration(homeDir).plugins.filter(entry => entry.id === 'learning.distiller');
    if (entries.length !== 1) return undefined;
    const entry = entries[0]!;
    if (entry.builtin !== true || entry.enabled === false) return undefined;
    const parsed = configurationSchema.safeParse(entry.config);
    if (!parsed.success) return undefined;
    const directory = join(homeDir, '.afk', 'learning');
    return { homeDir, file: join(directory, 'candidates.sqlite'), recoveryDirectory: join(directory, 'publications'),
      config: parsed.data.knowledge, validationConfigurationFile: parsed.data.validation.configurationFile };
  } catch { return undefined; }
}
