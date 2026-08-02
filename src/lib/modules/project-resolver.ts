/**
 * ProjectResolverModule — chdirs to the target project repo before worktree
 * creation. Core infrastructure (registered in CORE_MODULES), not opt-in.
 *
 * Lifecycle:
 *   onInit    → resolve projectName via ProjectResolver → process.chdir
 *   onCleanup → chdir back to originalCwd (best-effort)
 *
 * If no projectName is set in the InitContext, the module is a no-op
 * (cwd-based dispatch stays the same).
 *
 * Why chdir: subsequent operations (worktree.create, simple-git, statusline)
 * assume cwd is the target repo. Doing it here means no other code has to
 * think about cross-project dispatch.
 */
import { chdir } from 'process';
import { JumpProjectResolver } from '../core/project-resolver';
import type { InitContext, LifecycleContext, LifecycleModule } from '../workflows/lifecycle';
import { logger } from '../io';

export class ProjectResolverModule implements LifecycleModule {
  name = 'project-resolver';
  private originalCwd: string | undefined;

  constructor(private readonly resolver = new JumpProjectResolver()) {}

  async onInit(ctx: InitContext): Promise<void> {
    if (!ctx.projectName) return; // no-op: cwd-based dispatch unchanged

    // Trust the runner's originalCwd: it captures cwd at the very top of
    // run(), before any chdir happens anywhere in the chain.
    this.originalCwd = ctx.originalCwd;
    try {
      const target = await this.resolver.resolve(ctx.projectName);
      chdir(target);
      logger.info({ iid: ctx.iid, projectName: ctx.projectName, from: this.originalCwd, to: target }, 'chdir to target project');
    } catch (resolveErr) {
      // resolve failed: try clone as fallback so a fresh checkout still works.
      logger.warn({ iid: ctx.iid, projectName: ctx.projectName, err: resolveErr }, 'resolve failed; falling back to clone');
      const cloned = await this.resolver.clone(ctx.projectName);
      chdir(cloned);
      logger.info({ iid: ctx.iid, projectName: ctx.projectName, cloned }, 'chdir to fresh clone');
    }
  }

  async onCleanup(_ctx: LifecycleContext): Promise<void> {
    if (this.originalCwd) {
      try {
        chdir(this.originalCwd);
      } catch (err) {
        logger.warn({ err, originalCwd: this.originalCwd }, 'failed to restore cwd');
      }
      this.originalCwd = undefined;
    }
  }
}

export default () => new ProjectResolverModule();