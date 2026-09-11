/**
 * Module registry — auto-discovers modules from src/application/modules/ and
 * resolves the active set from CLI flags, config file, or env var.
 *
 * Priority (highest wins):
 *   1. CLI --ext flags (explicit)
 *   2. .afk/config.yml → workflow.modules
 *   3. AFK_MODULES env var
 */
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { load } from 'js-yaml';
import type { LifecycleModule, ModuleFactory } from '../workflows/lifecycle';

// Module registry: maps module name → factory function.
// Module files are NOT imported at module load time — they are dynamically
// imported on first access via the `ensureModule()` lazy loader.
const MODULE_LOADERS: Record<string, () => Promise<ModuleFactory>> = {
  isolate: () => import('./isolate').then(m => m.default),
  'project-resolver': () => import('./project-resolver').then(m => m.default),
};

function validateModuleNames(names: string[]): string[] {
  const unique = [...new Set(names)];
  for (const name of unique) {
    if (!MODULE_LOADERS[name]) throw new Error(`Unknown module: ${name}. Available: ${Object.keys(MODULE_LOADERS).join(', ')}`);
  }
  return unique;
}

export async function resolveModuleNames(cliExt?: string[]): Promise<string[]> {
  const configNames = loadConfigModules();
  const names = cliExt?.length
    ? cliExt
    : configNames.length
      ? configNames
      : (process.env.AFK_MODULES ?? '').split(',').map(name => name.trim()).filter(Boolean);
  return validateModuleNames(names);
}

const CORE_MODULE_NAMES = ['project-resolver'];

export async function loadModules(cliExt?: string[]): Promise<LifecycleModule[]> {
  const optInNames = await resolveModuleNames(cliExt);
  const factories = await Promise.all(validateModuleNames([...CORE_MODULE_NAMES, ...optInNames]).map(name => MODULE_LOADERS[name]()));
  return factories.map(factory => factory());
}

export type ModuleParamValue = string;
export type ModuleParams = Record<string, Record<string, ModuleParamValue>>;

export function parseModuleParams(params: string[] | undefined): ModuleParams {
  if (!params || params.length === 0) return {};

  const result: ModuleParams = {};
  for (const param of params) {
    const dot = param.indexOf('.');
    const eq = param.indexOf('=');
    if (dot < 0 || eq < 0 || eq <= dot) continue;

    const moduleName = param.slice(0, dot);
    const key = param.slice(dot + 1, eq);
    const value = param.slice(eq + 1);

    const moduleParams = result[moduleName] ?? {};
    moduleParams[key] = value;
    result[moduleName] = moduleParams;
  }

  return result;
}

function loadConfigModules(): string[] {
  const configPath = join(process.cwd(), '.afk', 'config.yml');
  if (!existsSync(configPath)) return [];

  try {
    const config = load(readFileSync(configPath, 'utf-8')) as { workflow?: { modules?: unknown } } | null;
    const modules = config?.workflow?.modules;
    return Array.isArray(modules) ? modules.filter((name): name is string => typeof name === 'string').map(name => name.trim()).filter(Boolean) : [];
  } catch {
    return [];
  }
}
