import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../../lib/io';

export interface LoopConfig {
  moduleTriggers: Record<string, string[]>;
}

const DEFAULT_LOOP_CONFIG: LoopConfig = { moduleTriggers: {} };

/** Load provider-neutral loop module triggers from .afk/config.yml. */
export function loadLoopConfig(cwd: string = process.cwd()): LoopConfig {
  const configPath = path.join(cwd, '.afk', 'config.yml');
  const result: LoopConfig = {
    moduleTriggers: {},
  };

  try {
    if (!fs.existsSync(configPath)) return cloneDefaultConfig();

    const raw = fs.readFileSync(configPath, 'utf-8');
    let inTriggers = false;

    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (trimmed === 'module_triggers:') {
        inTriggers = true;
        continue;
      }
      if (!inTriggers) continue;

      const colon = trimmed.lastIndexOf(':');
      if (colon < 0) {
        inTriggers = false;
        continue;
      }

      const trigger = trimmed.slice(0, colon).trim();
      const value = trimmed.slice(colon + 1).trim();
      if (!trigger) {
        inTriggers = false;
        continue;
      }

      const listMatch = value.match(/^\[([^\]]*)\]$/);
      if (listMatch) {
        result.moduleTriggers[trigger] = listMatch[1]
          .split(',')
          .map(moduleName => moduleName.trim())
          .filter(Boolean);
      }
    }
  } catch (error) {
    logger.warn({ err: error, path: configPath }, 'failed to load loop config');
  }

  return result;
}

function cloneDefaultConfig(): LoopConfig {
  return { moduleTriggers: { ...DEFAULT_LOOP_CONFIG.moduleTriggers } };
}
