/**
 * The template catalogue — the one module that owns the workflow templates
 * and produces the one compiled plan the runtime executes.
 *
 * A template used to reach the runtime through three doors: a name on the
 * command line, a file in the project's `.afk/workflows/`, or a built-in.
 * Each door had its own loader, and behind them sat a process-global registry
 * — so a test could register a template that production code happened to see,
 * and nothing said which template a run would actually use. The catalogue is
 * an instance instead: the templates it holds, the place it looks for them
 * and the plan it compiles are all one object's business. A test that
 * registers a template registers it into the catalogue the code under test
 * was given.
 *
 * What the catalogue owns:
 *
 *   - the templates — the built-ins are registered on construction, and
 *     `register` adds a plugin's or a test's own;
 *   - the loading — the search priority chain, unchanged:
 *
 *       CLI path (name contains '/' or ends .yml/.yaml)  > highest
 *       <project>/.afk/workflows/<name>.yml | .yaml
 *       <home>/.afk/workflows/<name>.yml | .yaml
 *       the templates registered here (the built-ins)   > lowest
 *
 *     A file that fails to parse or validate raises TemplateError with the
 *     path and the flattened Zod issues.
 *
 *   - the compilation — one plan shape comes out of it: the groups of steps,
 *     each step carrying kind, phase, completion protocol, provider, prompt,
 *     branch, level, dependencies and condition.
 *
 * The catalogue holds no process-global state: two catalogues do not see each
 * other's registrations.
 */

import { homedir } from 'os';
import { builtinTemplates } from './builtin.js';
import {
  compileTemplate,
  planSteps,
  selectStep,
  type CompiledExecutionPlan,
  type CompiledStep,
  type StepSelector,
} from './compiler.js';
import { findTemplateFile, type LoadedTemplate, type TemplateSearchRoots, type TemplateSource } from './loader.js';
import { TemplateError, type WorkflowTemplate } from './types.js';

export type { LoadedTemplate, TemplateSource, StepSelector };

export interface TemplateCatalogOptions {
  /** Project root that owns `.afk/workflows/`. Defaults to process.cwd(). */
  projectRoot?: string;
  /** User home that owns `~/.afk/workflows/`. Defaults to os.homedir(). */
  homeDir?: string;
  /** Templates registered on construction, on top of the built-ins. */
  templates?: Iterable<WorkflowTemplate>;
}

/** Where a call looks for a template on disk. */
export interface TemplateRequest {
  /** Project root that owns `.afk/workflows/`. Defaults to the catalogue's root. */
  projectRoot?: string;
  /** User home that owns `~/.afk/workflows/`. Defaults to the catalogue's home. */
  homeDir?: string;
}

/** What the compiler needs beyond the template. */
export interface CompileOptions {
  /** System actions the compiler accepts besides the built-in ones. */
  systemActions?: Iterable<string>;
}

/**
 * One catalogue: the templates it holds, the place it looks for them and
 * the one plan they compile into. An instance, never a module-level
 * singleton — two catalogues do not see each other's registrations.
 */
export class TemplateCatalog {
  private readonly templates = new Map<string, WorkflowTemplate>();
  private readonly projectRoot: string;
  private readonly homeDir: string;

  constructor(options: TemplateCatalogOptions = {}) {
    this.projectRoot = options.projectRoot ?? process.cwd();
    this.homeDir = options.homeDir ?? homedir();
    for (const template of builtinTemplates()) this.templates.set(template.name, template);
    for (const template of options.templates ?? []) this.templates.set(template.name, template);
  }

  /** Register a template by name. Overwrites an existing one. */
  register(template: WorkflowTemplate): void {
    this.templates.set(template.name, template);
  }

  /** The names of the templates this catalogue holds. */
  names(): string[] {
    return [...this.templates.keys()];
  }

  /** The template this catalogue holds under a name, if it holds one. */
  find(name: string): WorkflowTemplate | undefined {
    return this.templates.get(name);
  }

  /** The template, and where it came from. */
  async loadWithSource(name: string, request: TemplateRequest = {}): Promise<LoadedTemplate> {
    const found = await findTemplateFile(name, this.rootsFor(request));
    if (found) return found;
    // The lowest-priority source: the templates this catalogue holds.
    const registered = this.templates.get(name);
    if (registered) return { template: registered, source: 'builtin' };
    throw new TemplateError(`template '${name}' not found in CLI / project / user paths`, name);
  }

  /** The template alone. */
  async load(name: string, request: TemplateRequest = {}): Promise<WorkflowTemplate> {
    return (await this.loadWithSource(name, request)).template;
  }

  /** The one plan compiled from a template. */
  compile(template: WorkflowTemplate, options: CompileOptions = {}): CompiledExecutionPlan {
    return compileTemplate(template, { systemActions: options.systemActions });
  }

  /**
   * The first step of a plan that matches the selector, in execution order.
   * A caller that wants "the QA step" asks for it here instead of digging
   * through the plan's groups.
   */
  selectStep(plan: CompiledExecutionPlan, selector: StepSelector): CompiledStep | undefined {
    return selectStep(planSteps(plan), selector);
  }

  private rootsFor(request: TemplateRequest): TemplateSearchRoots {
    return {
      projectRoot: request.projectRoot ?? this.projectRoot,
      homeDir: request.homeDir ?? this.homeDir,
    };
  }
}
