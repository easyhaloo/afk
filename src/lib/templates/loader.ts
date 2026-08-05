/**
 * Template loader — reads YAML templates from disk and validates them.
 *
 * Priority chain (per design):
 *   CLI path (--template ./local.yml)         > highest
 *   <project>/.afk/workflows/<name>.yml
 *   ~/.afk/workflows/<name>.yml
 *   builtin templates (registry)              > lowest
 *
 * The loader is intentionally simple — it doesn't watch for file changes.
 * Templates are loaded once per process and cached.
 *
 * Files that fail to parse or validate raise TemplateError with the path +
 * a structured message (Zod issues are flattened into the error message).
 */

import { promises as fs } from 'fs';
import { dirname, isAbsolute, join, resolve } from 'path';
import { homedir } from 'os';
import * as YAML from 'js-yaml';
import { WorkflowTemplateSchema, type WorkflowTemplate } from './types';
import { TemplateError } from './types';
import { getTemplate } from './registry';

export type TemplateSource = 'cli' | 'project' | 'user' | 'builtin';
export interface LoadedTemplate {
  template: WorkflowTemplate;
  source: TemplateSource;
  /** Directory that owns prompt paths. Undefined for in-memory builtins. */
  baseDir?: string;
}

export interface TemplateLoaderOptions {
  /** Project root for `.afk/workflows/`. Defaults to process.cwd(). */
  projectRoot?: string;
  /** User home for `~/.afk/workflows/`. Defaults to os.homedir(). */
  homeDir?: string;
  /** Override the cache (used by tests to force re-load). */
  bypassCache?: boolean;
}

export class TemplateLoader {
  private readonly projectRoot: string;
  private readonly homeDir: string;
  private readonly cache = new Map<string, LoadedTemplate>();

  constructor(opts: TemplateLoaderOptions = {}) {
    this.projectRoot = opts.projectRoot ?? process.cwd();
    this.homeDir = opts.homeDir ?? homedir();
  }

  /** Search priority chain for the named template; returns first hit. */
  async load(name: string, opts: TemplateLoaderOptions = {}): Promise<WorkflowTemplate> {
    return (await this.loadWithSource(name, opts)).template;
  }

  /** Load a template plus its origin so callers can resolve relative assets. */
  async loadWithSource(name: string, opts: TemplateLoaderOptions = {}): Promise<LoadedTemplate> {
    if (!opts.bypassCache && this.cache.has(name)) {
      return this.cache.get(name)!;
    }

    // CLI path: if name contains '/' or '.yml', treat as a direct file path.
    const candidates: Array<{ path: string; source: TemplateSource }> = [];
    if (name.includes('/') || name.endsWith('.yml') || name.endsWith('.yaml')) {
      candidates.push({ path: name, source: 'cli' });
    }
    candidates.push({ path: join(this.projectRoot, '.afk', 'workflows', `${name}.yml`), source: 'project' });
    candidates.push({ path: join(this.projectRoot, '.afk', 'workflows', `${name}.yaml`), source: 'project' });
    candidates.push({ path: join(this.homeDir, '.afk', 'workflows', `${name}.yml`), source: 'user' });
    candidates.push({ path: join(this.homeDir, '.afk', 'workflows', `${name}.yaml`), source: 'user' });

    for (const c of candidates) {
      try {
        const content = await fs.readFile(c.path, 'utf-8');
        const template = this.resolvePromptPaths(this.parseAndValidate(content, name), dirname(resolve(c.path)));
        const loaded = { template, source: c.source, baseDir: dirname(resolve(c.path)) };
        this.cache.set(name, loaded);
        return loaded;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
        if (err instanceof TemplateError) {
          // Wrap with file context but rethrow.
          throw new TemplateError(`${err.message} (source: ${c.source}, path: ${c.path})`, name, err);
        }
        throw err;
      }
    }
    const builtin = getTemplate(name);
    if (builtin) {
      const loaded = { template: builtin, source: 'builtin' as const };
      this.cache.set(name, loaded);
      return loaded;
    }
    throw new TemplateError(`template '${name}' not found in CLI / project / user paths`, name);
  }

  /** Parse + validate raw YAML content. Exposed for tests + builtin loading. */
  parseAndValidate(content: string, name: string): WorkflowTemplate {
    let raw: unknown;
    try {
      raw = YAML.load(content);
    } catch (err) {
      throw new TemplateError(`YAML parse failed: ${(err as Error).message}`, name, err);
    }
    const result = WorkflowTemplateSchema.safeParse(raw);
    if (!result.success) {
      const issues = result.error.issues.map(i => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
      throw new TemplateError(`schema validation failed:\n${issues}`, name);
    }
    return result.data;
  }

  /** Clear the cache (used by tests after filesystem changes). */
  clearCache(): void {
    this.cache.clear();
  }

  private resolvePromptPaths(template: WorkflowTemplate, baseDir: string): WorkflowTemplate {
    return {
      ...template,
      steps: template.steps.map(step => {
        if (!step.prompt || typeof step.prompt === 'string' || isAbsolute(step.prompt.file)) return step;
        return { ...step, prompt: { file: resolve(baseDir, step.prompt.file) } };
      }),
    };
  }
}
