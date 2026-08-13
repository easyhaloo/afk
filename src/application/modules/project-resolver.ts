/**
 * ProjectResolverModule — resolves the target project repo before worktree
 * creation. Core infrastructure (registered in CORE_MODULES), not opt-in.
 *
 * Resolution is explicit in InitContext.repoRoot; process.cwd() is never
 * changed, so concurrent/cross-project runs cannot affect one another.
 *
 * If no projectName is set in the InitContext, the module is a no-op
 * (cwd-based dispatch stays the same).
 *
 * Why chdir: subsequent operations (worktree.create, simple-git, statusline)
 * assume cwd is the target repo. Doing it here means no other code has to
 * think about cross-project dispatch.
 */
import { JumpProjectResolver } from './project-resolver';
import type { InitContext, LifecycleContext, LifecycleModule } from '../workflows/lifecycle';
import { logger } from '../../infrastructure/io/index';

export class ProjectResolverModule implements LifecycleModule {
  name = 'project-resolver';
  constructor(private readonly resolver = new JumpProjectResolver()) {}

  async onInit(ctx: InitContext): Promise<void> {
    if (!ctx.projectName) return; // no-op: cwd-based dispatch unchanged

    if (ctx.repoRoot) return;
    try {
      const target = await this.resolver.resolve(ctx.projectName);
      ctx.repoRoot = target;
      logger.info({ iid: ctx.iid, projectName: ctx.projectName, repoRoot: target }, 'resolved target project');
    } catch (resolveErr) {
      // resolve failed: try clone as fallback so a fresh checkout still works.
      logger.warn({ iid: ctx.iid, projectName: ctx.projectName, err: resolveErr }, 'resolve failed; falling back to clone');
      const cloned = await this.resolver.clone(ctx.projectName);
      ctx.repoRoot = cloned;
      logger.info({ iid: ctx.iid, projectName: ctx.projectName, repoRoot: cloned }, 'resolved fresh project clone');
    }
  }

  async onCleanup(_ctx: LifecycleContext): Promise<void> { /* no process-global state to restore */ }
}

export default () => new ProjectResolverModule();
