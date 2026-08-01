/**
 * Fork module — provides isolated database/redis/es containers per worktree.
 *
 * Lifecycle:
 *   onBeforeAgent → ForkManager.up() → write .env → write .afk/fork.json
 *   onAfterAgent  → ForkManager.discard() → cleanup
 *
 * Agent discovers fork connection info by reading `.afk/fork.json` in the
 * worktree root. If no docker-compose.yml exists, the module is a no-op.
 */
import { promises as fs } from 'fs';
import { join } from 'path';
import { ForkManager, gc as forkGc } from '../forks';
import { defineModule } from './_registry';
import type { LifecycleContext } from '../workflows/lifecycle';

export default defineModule(() => ({
  name: 'fork',

  async onBeforeAgent(ctx: LifecycleContext): Promise<void> {
    const fm = new ForkManager(ctx.worktreePath);
    if (!fm.available()) {
      // No docker-compose.yml — silently skip, project may not need middleware
      return;
    }

    try {
      const info = await fm.up();
      // Write fork info to .afk/fork.json so the agent can discover it
      const forkDir = join(ctx.worktreePath, '.afk');
      await fs.mkdir(forkDir, { recursive: true });
      await fs.writeFile(
        join(forkDir, 'fork.json'),
        JSON.stringify({
          available: true,
          services: info.services.map(s => ({
            name: s.name,
            host: s.host,
            port: s.port,
            containerPort: s.containerPort,
            envVar: s.envVar,
          })),
        }, null, 2),
        'utf-8',
      );
    } catch (err) {
      // Fork failure is non-fatal: agent can still work with shared middleware
      const forkDir = join(ctx.worktreePath, '.afk');
      await fs.mkdir(forkDir, { recursive: true });
      await fs.writeFile(
        join(forkDir, 'fork.json'),
        JSON.stringify({ available: false, error: (err as Error).message }, null, 2),
        'utf-8',
      );
    }
  },

  async onAfterAgent(ctx: LifecycleContext): Promise<void> {
    try {
      const fm = new ForkManager(ctx.worktreePath);
      await fm.discard();
    } catch {
      // Best-effort cleanup
    }
  },

  async onCleanup(ctx: LifecycleContext): Promise<void> {
    // Periodic GC: clean up stale port assignments
    try {
      await forkGc();
    } catch {
      // Best-effort
    }
  },
}));