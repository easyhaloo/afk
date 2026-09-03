/**
 * Isolate module — provides isolated database/redis/es containers per worktree.
 *
 * Lifecycle:
 *   onBeforeAgent → IsolateManager.up() → write .env → write .afk/isolate.json
 *   onAfterAgent  → IsolateManager.discard() → cleanup
 *
 * Agent discovers isolate connection info by reading `.afk/isolate.json` in the
 * worktree root. If no docker-compose.yml exists, the module is a no-op.
 */
import { promises as fs } from 'fs';
import { join } from 'path';
import { IsolateManager, isolateGc } from '../isolate';
import { defineModule } from './_registry';
import type { LifecycleContext } from '../workflows/lifecycle';

export default defineModule(() => ({
  name: 'isolate',

  async onBeforeAgent(ctx: LifecycleContext): Promise<void> {
    const im = new IsolateManager(ctx.worktreePath);
    if (!im.available()) {
      // No docker-compose.yml — silently skip, project may not need middleware
      return;
    }

    try {
      const info = await im.up();
      // Write isolate info to .afk/isolate.json so the agent can discover it
      const isolateDir = join(ctx.worktreePath, '.afk');
      await fs.mkdir(isolateDir, { recursive: true });
      await fs.writeFile(
        join(isolateDir, 'isolate.json'),
        JSON.stringify({
          available: true,
          isolateName: info.isolateName,
          composeProjectName: `isolate-${info.isolateName}`,
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
      // Isolate failure is non-fatal: agent can still work with shared middleware
      const isolateDir = join(ctx.worktreePath, '.afk');
      await fs.mkdir(isolateDir, { recursive: true });
      await fs.writeFile(
        join(isolateDir, 'isolate.json'),
        JSON.stringify({ available: false, error: (err as Error).message }, null, 2),
        'utf-8',
      );
    }
  },

  async onAfterAgent(ctx: LifecycleContext): Promise<void> {
    try {
      const im = new IsolateManager(ctx.worktreePath, { workspaceRoot: ctx.repoRoot });
      await im.discard();
    } catch {
      // Best-effort cleanup
    }
  },

  async onCleanup(ctx: LifecycleContext): Promise<void> {
    // Periodic GC: clean up stale port assignments
    try {
      await isolateGc();
    } catch {
      // Best-effort
    }
  },
}));