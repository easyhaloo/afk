/**
 * The disk half of the template catalogue.
 *
 * This module knows how to find a template file, read it and validate it.
 * It does not know the search chain as a whole, and it does not know what
 * else the catalogue holds: the catalogue owns both, and this module is the
 * detail it keeps for itself.
 *
 * The search priority chain (per design):
 *   CLI path (--template ./local.yml)         > highest
 *   <project>/.afk/workflows/<name>.yml
 *   ~/.afk/workflows/<name>.yml
 *   the catalogue's registered templates      > lowest
 *
 * Files that fail to parse or validate raise TemplateError with the path +
 * a structured message (Zod issues are flattened into the error message).
 */

import { AFK_WORKFLOW_DIRECTORY } from '@afk/core';
import { promises as fs } from 'fs';
import { dirname, isAbsolute, join, resolve } from 'path';
import * as YAML from 'js-yaml';
import { WorkflowTemplateSchema, type WorkflowTemplate } from './types.js';
import { TemplateError } from './types.js';

export type TemplateSource = 'cli' | 'project' | 'user' | 'builtin';
export interface LoadedTemplate {
  template: WorkflowTemplate;
  source: TemplateSource;
  /** Directory that owns prompt paths. Undefined for in-memory builtins. */
  baseDir?: string;
}

/** Where the catalogue looks for template files. */
export interface TemplateSearchRoots {
  /** Project root that owns `.afk/workflows/`. */
  projectRoot: string;
  /** User home that owns `~/.afk/workflows/`. */
  homeDir: string;
}

/** The files a template name may live in, in priority order. */
export function templateCandidates(name: string, roots: TemplateSearchRoots): Array<{ path: string; source: TemplateSource }> {
  const candidates: Array<{ path: string; source: TemplateSource }> = [];
  // CLI path: if name contains '/' or '.yml', treat as a direct file path.
  if (name.includes('/') || name.endsWith('.yml') || name.endsWith('.yaml')) {
    candidates.push({ path: name, source: 'cli' });
  }
  candidates.push({ path: join(roots.projectRoot, AFK_WORKFLOW_DIRECTORY, `${name}.yml`), source: 'project' });
  candidates.push({ path: join(roots.projectRoot, AFK_WORKFLOW_DIRECTORY, `${name}.yaml`), source: 'project' });
  candidates.push({ path: join(roots.homeDir, AFK_WORKFLOW_DIRECTORY, `${name}.yml`), source: 'user' });
  candidates.push({ path: join(roots.homeDir, AFK_WORKFLOW_DIRECTORY, `${name}.yaml`), source: 'user' });
  return candidates;
}

/**
 * The first template file that exists, in priority order. Undefined when no
 * candidate file is there — the catalogue then falls back to the templates it
 * holds.
 */
export async function findTemplateFile(name: string, roots: TemplateSearchRoots): Promise<LoadedTemplate | undefined> {
  for (const candidate of templateCandidates(name, roots)) {
    try {
      const content = await fs.readFile(candidate.path, 'utf-8');
      const template = resolvePromptPaths(parseTemplate(content, name), dirname(resolve(candidate.path)));
      return { template, source: candidate.source, baseDir: dirname(resolve(candidate.path)) };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      if (err instanceof TemplateError) {
        // Wrap with file context but rethrow.
        throw new TemplateError(`${err.message} (source: ${candidate.source}, path: ${candidate.path})`, name, err);
      }
      throw err;
    }
  }
  return undefined;
}

/** Parse + validate raw YAML content. */
export function parseTemplate(content: string, name: string): WorkflowTemplate {
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

/** A prompt that names a file is resolved against the template's own directory. */
function resolvePromptPaths(template: WorkflowTemplate, baseDir: string): WorkflowTemplate {
  return {
    ...template,
    steps: template.steps.map(step => {
      if (!step.prompt || typeof step.prompt === 'string' || isAbsolute(step.prompt.file)) return step;
      return { ...step, prompt: { file: resolve(baseDir, step.prompt.file) } };
    }),
  };
}
