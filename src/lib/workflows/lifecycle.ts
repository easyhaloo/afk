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
}

export interface LifecycleModule {
  /** Module name, used in --ext and config matching */
  name: string;

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

export type ModuleFactory = () => LifecycleModule;