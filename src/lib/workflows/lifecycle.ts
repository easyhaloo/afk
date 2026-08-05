import type { ProjectContext } from '../core/project-context';

export type LifecyclePhase = 'init' | 'before-agent' | 'after-agent' | 'cleanup';

/**
 * Workflow lifecycle interfaces and module system.
 *
 * Modules are auto-discovered from src/lib/modules/*.ts and run at
 * lifecycle points in the workflow runner. Users activate modules via:
 *   - CLI: afk workflow run --iid 42 --ext isolate
 *   - Config: .afk/config.yml → workflow.modules
 *   - Env:   AFK_MODULES=isolate,mock-server
 */

/**
 * Init-phase context: pre-worktree infrastructure setup. Distinct from
 * LifecycleContext because worktreePath and sessionName don't exist yet at
 * this stage (ProjectResolver may chdir to a different repo before any
 * worktree is created).
 */
export interface InitContext {
  /** Issue IID being worked on */
  iid: number;
  /** Target project name (from --project flag or issue.projectId), if known */
  projectName: string | undefined;
  /** Base branch the worktree will be created from */
  baseBranch: string;
  /** Module-specific parameters from CLI / config */
  params: Record<string, unknown>;
  /** cwd before onInit ran; modules that chdir should restore from here */
  originalCwd: string;
  /** Explicit target repository. Hooks must use this instead of process.cwd(). */
  repoRoot?: string;
  /** Resolved project identity, when dispatching cross-project. */
  projectContext?: ProjectContext;
}

export interface LifecycleContext {
  /** Issue IID being worked on */
  iid: number;
  /** Absolute path to the worktree */
  worktreePath: string;
  /** Base branch the worktree was created from */
  baseBranch: string;
  /** Tmux session name */
  sessionName: string;
  /** Module-specific parameters from CLI / config */
  params: Record<string, unknown>;
  /** Explicit target repository. */
  repoRoot?: string;
  /** Resolved project identity, when dispatching cross-project. */
  projectName?: string;
  originalCwd?: string;
}

export interface LifecycleModule {
  /** Module name, used in --ext and config matching */
  name: string;
  /** Lower values run first; registration order breaks ties. */
  order?: number;

  /**
   * Called BEFORE worktree creation, after modules are loaded. Use for
   * pre-worktree infrastructure (e.g., chdir to target repo via ProjectResolver).
   * Failure here terminates the run — init is infrastructure, not opt-in.
   */
  onInit?(ctx: InitContext): Promise<void>;

  /** Called after worktree creation, before agent starts */
  onBeforeAgent?(ctx: LifecycleContext): Promise<void>;

  /** Called after agent completes (success or failure) */
  onAfterAgent?(ctx: LifecycleContext): Promise<void>;

  /** Called during cleanup phase */
  onCleanup?(ctx: LifecycleContext): Promise<void>;
}

/**
 * Typed lifecycle dispatcher. Existing module hooks remain the compatibility
 * surface; new phases can be added here without teaching the runner about each
 * module. Cleanup is always reverse ordered and errors are best effort except
 * for init, which is infrastructure and therefore fails the run.
 */
export class LifecycleDispatcher {
  private readonly modules: LifecycleModule[];
  private readonly extensions = new Map<LifecyclePhase, Array<{ order: number; index: number; handler: (ctx: InitContext | LifecycleContext) => Promise<void> }>>();

  constructor(modules: LifecycleModule[] = []) {
    this.modules = modules.map((module, index) => ({ ...module, order: module.order ?? index }));
    this.modules.sort((a, b) => (a.order! - b.order!));
  }

  register(phase: LifecyclePhase, handler: (ctx: InitContext | LifecycleContext) => Promise<void>, order = 0): void {
    const list = this.extensions.get(phase) ?? [];
    list.push({ order, index: list.length, handler });
    list.sort((a, b) => a.order - b.order || a.index - b.index);
    this.extensions.set(phase, list);
  }

  async run(phase: LifecyclePhase, ctx: InitContext | LifecycleContext): Promise<void> {
    const entries = phase === 'cleanup' ? [...this.modules].reverse() : this.modules;
    for (const module of entries) {
      const hook = phase === 'init' ? module.onInit
        : phase === 'before-agent' ? module.onBeforeAgent
          : phase === 'after-agent' ? module.onAfterAgent : module.onCleanup;
      if (!hook) continue;
      try {
        await hook(ctx as never);
      } catch (error) {
        if (phase === 'init') throw error;
      }
    }
    const extensions = this.extensions.get(phase) ?? [];
    const ordered = phase === 'cleanup' ? [...extensions].reverse() : extensions;
    for (const extension of ordered) {
      try {
        await extension.handler(ctx);
      } catch (error) {
        if (phase === 'init') throw error;
      }
    }
  }
}

export type ModuleFactory = () => LifecycleModule;
