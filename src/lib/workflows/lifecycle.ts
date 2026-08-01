/**
 * Workflow lifecycle interfaces and module system.
 *
 * Modules are auto-discovered from src/lib/modules/*.ts and run at
 * lifecycle points in the workflow runner. Users activate modules via:
 *   - CLI: afk workflow run --iid 42 --ext fork
 *   - Config: .afk/config.yml → workflow.modules
 *   - Env:   AFK_MODULES=fork,mock-server
 */

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
}

export interface LifecycleModule {
  /** Module name, used in --ext and config matching */
  name: string;

  /** Called after worktree creation, before agent starts */
  onBeforeAgent?(ctx: LifecycleContext): Promise<void>;

  /** Called after agent completes (success or failure) */
  onAfterAgent?(ctx: LifecycleContext): Promise<void>;

  /** Called during cleanup phase */
  onCleanup?(ctx: LifecycleContext): Promise<void>;
}

export type ModuleFactory = () => LifecycleModule;