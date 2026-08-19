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
import type { LifecycleModule, ModuleFactory } from '../workflows/lifecycle';

// Module registry: maps module name → factory function.
// Module files are NOT imported at module load time — they are dynamically
// imported on first access via the `ensureModule()` lazy loader.
const MODULE_LOADERS: Record<string, () => Promise<ModuleFactory>> = {
  isolate: () => import('./isolate').then(m => m.default),
  'project-resolver': () => import('./project-resolver').then(m => m.default),
};

const _registry = new Map<string, ModuleFactory>();

async function ensureModule(name: string): Promise<void> {
  if (_registry.has(name)) return;
  const loader = MODULE_LOADERS[name];
  if (!loader) throw new Error(`Unknown module: ${name}. Available: ${Object.keys(MODULE_LOADERS).join(', ')}`);
  const factory = await loader();
  _registry.set(name, factory);
}

export function defineModule(factory: ModuleFactory): ModuleFactory {
  const mod = factory();
  if (_registry.has(mod.name)) throw new Error(`Duplicate module name: ${mod.name}`);
  _registry.set(mod.name, factory);
  return factory;
}

export async function resolveModuleNames(cliExt?: string[]): Promise<string[]> {
  const seen = new Set<string>();
  if (cliExt && cliExt.length > 0) {
    for (const name of cliExt) {
      await ensureModule(name);
      seen.add(name);
    }
    return [...seen];
  }

  const configNames = loadConfigModules();
  if (configNames.length > 0) {
    for (const name of configNames) {
      await ensureModule(name);
      seen.add(name);
    }
    return [...seen];
  }

  const env = process.env.AFK_MODULES;
  if (env) {
    for (const name of env.split(',').map(s => s.trim()).filter(Boolean)) {
      await ensureModule(name);
      seen.add(name);
    }
    return [...seen];
  }
  return [];
}

const CORE_MODULE_NAMES = ['project-resolver'];

export async function loadModules(cliExt?: string[]): Promise<LifecycleModule[]> {
  for (const name of CORE_MODULE_NAMES) await ensureModule(name);
  const optInNames = await resolveModuleNames(cliExt);
  return [...CORE_MODULE_NAMES, ...optInNames].map(name => _registry.get(name)!());
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
    const raw = readFileSync(configPath, 'utf-8');
    const lines = raw.split('\n').map(l => l.trim());
    let inModules = false;
    const modules: string[] = [];

    for (const line of lines) {
      if (line === 'workflow:') { inModules = false; continue; }
      if (line === 'modules:' && inModules === false) { inModules = true; continue; }
      if (inModules) {
        if (line.startsWith('- ')) modules.push(line.slice(2).trim());
        else if (line.startsWith('-') || line.startsWith('#')) continue;
        else inModules = false;
      }
    }
    return modules;
  } catch {
    return [];
  }
}

export function _resetRegistry(): void {
  _registry.clear();
}
