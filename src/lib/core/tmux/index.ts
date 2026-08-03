/**
 * Tmux core.
 */
import { TmuxClient } from './tmux';
export { TmuxClient };
export type { TmuxSession, TmuxCaptureOptions } from './tmux';

/**
 * Factory: create a TmuxClient instance.
 * Tests may inject a fake via RunnerDependencies.tmux instead.
 */
export function createTmuxClient(): TmuxClient {
  return new TmuxClient();
}
