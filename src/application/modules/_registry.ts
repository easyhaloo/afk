/**
 * Module registry — auto-discovers modules from src/lib/modules/ and
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
//
// To add a new module:
//   1. Create src/lib/modules/<name>.ts — default export a ModuleFactory
//   2. Add a loader entry in the `MODULE_LOADERS` record below
const MODULE_LOADERS: Record<string, () => Promise<ModuleFactory>> = {
  isolate: () => import('./isolate').then(m => m.default),
  'project-resolver': () => import('./project-resolver').then(m => m.default),
};

// In-memory cache of resolved module factories
const _registry = new Map<string, ModuleFactory>();

/**
 * Ensure a module is loaded into the registry. Dynamically imports the module
 * file on first access, then caches the factory.
 */
async function ensureModule(name: string): Promise<void> {
  if (_registry.has(name)) return;
  const loader = MODULE_LOADERS[name];
  if (!loader) throw new Error(`Unknown module: ${name}. Available: ${Object.keys(MODULE_LOADERS).join(', ')}`);
  const factory = await loader();
  _registry.set(name, factory);
}

/**
 * Register a module factory at import time (for static imports).
 * Usage: `defineModule(() => ({ name: 'isolate', ... }))`
 */
export function defineModule(factory: ModuleFactory): ModuleFactory {
  const mod = factory();
  if (_registry.has(mod.name)) {
    throw new Error(`Duplicate module name: ${mod.name}`);
  }
  _registry.set(mod.name, factory);
  return factory;
}

/**
 * Resolve activated module names from all configuration sources.
 * Priority: CLI > project config > env var.
 * Throws on unknown module names.
 */
export async function resolveModuleNames(cliExt?: string[]): Promise<string[]> {
  const seen = new Set<string>();

  // 1. CLI --ext (highest priority)
  if (cliExt && cliExt.length > 0) {
    for (const name of cliExt) {
      await ensureModule(name);
      seen.add(name);
    }
    return [...seen];
  }

  // 2. Project config: .afk/config.yml
  const configNames = loadConfigModules();
  if (configNames.length > 0) {
    for (const name of configNames) {
      await ensureModule(name);
      seen.add(name);
    }
    return [...seen];
  }

  // 3. Environment variable
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

/**
 * Modules that always load — infrastructure, not opt-in.
 * project-resolver chdirs to the target repo before worktree creation; if it
 * were opt-in, every cross-project dispatch would silently no-op.
 */
const CORE_MODULE_NAMES = ['project-resolver'];

/**
 * Load active modules for the lifecycle hooks.
 * Always-loaded core modules run first, followed by opt-in modules in
 * registration order.
 */
export async function loadModules(cliExt?: string[]): Promise<LifecycleModule[]> {
  for (const name of CORE_MODULE_NAMES) {
    await ensureModule(name);
  }
  const optInNames = await resolveModuleNames(cliExt);
  const allNames = [...CORE_MODULE_NAMES, ...optInNames];
  return allNames.map(name => {
    const factory = _registry.get(name)!;
    return factory();
  });
}

/**
 * Parse module params from --ext-param CLI flags.
 * Format: --ext-param isolate.auto=true --ext-param isolate.ports=3406,6380
 * Result: { isolate: { auto: 'true', ports: '3406,6380' } }
 */
export function parseModuleParams(params: string[] | undefined): Record<string, unknown> {
  if (!params || params.length === 0) return {};

  const result: Record<string, unknown> = {};

  for (const param of params) {
    // Parse "module.key=value"
    const dot = param.indexOf('.');
    const eq = param.indexOf('=');
    if (dot < 0 || eq < 0 || eq <= dot) continue;

    const moduleName = param.slice(0, dot);
    const key = param.slice(dot + 1, eq);
    const value = param.slice(eq + 1);

    if (!result[moduleName]) result[moduleName] = {};
    (result[moduleName] as Record<string, string>)[key] = value;
  }

  return result;
}

/**
 * Load module names from .afk/config.yml if it exists.
 * Expected format:
 * ```yaml
 * workflow:
 *   modules:
 *     - isolate
 *     - mock-server
 * ```
 */
function loadConfigModules(): string[] {
  const configPath = join(process.cwd(), '.afk', 'config.yml');
  if (!existsSync(configPath)) return [];

  try {
    const raw = readFileSync(configPath, 'utf-8');
    // Simple YAML parser for the workflow.modules key — no js-yaml dependency needed
    const lines = raw.split('\n').map(l => l.trim());
    let inModules = false;
    const modules: string[] = [];

    for (const line of lines) {
      if (line === 'workflow:') { inModules = false; continue; }
      if (line === 'modules:' && inModules === false) { inModules = true; continue; }
      if (inModules) {
        if (line.startsWith('- ')) {
          modules.push(line.slice(2).trim());
        } else if (line.startsWith('-') || line.startsWith('#')) {
          continue;
        } else {
          inModules = false; // end of list
        }
      }
    }

    return modules;
  } catch {
    return [];
  }
}

/** Exposed for testing */
export function _resetRegistry(): void {
  _registry.clear();
}