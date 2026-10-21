import type { ResourceRegistryPort, RunSessionPort } from '@afk/application';
import { TmuxClient } from '../tmux/tmux.js';
import { writeInterruptRequest } from './interrupt-file.js';
import { resourceRegistryPort } from './resource-registry-port.js';

/**
 * The part of the tmux client the stop needs.
 *
 * The client is named as an interface so a test can drive the stop
 * without a tmux binary, and so the stop does not depend on the client's
 * whole surface.
 */
export interface RunSessionControl {
  hasSession(name: string): Promise<boolean>;
  killSession(name: string): Promise<void>;
}

/**
 * Stopping a run, through the port.
 *
 * The run's session is the one the runtime registered for it, so the stop
 * cannot end a session that belongs to something else. The request is
 * written before the session is killed: a runtime that finds its session
 * gone can then say that a person asked for it, rather than reporting a
 * crash.
 */
export function createRunSessionPort(
  registry: ResourceRegistryPort,
  control: RunSessionControl = new TmuxClient(),
): RunSessionPort {
  return {
    async stop(runId: string): Promise<boolean> {
      const session = registry.readRun(runId).find(record => record.kind === 'tmux');
      if (!session) return false;
      if (!(await control.hasSession(session.name))) return false;
      await writeInterruptRequest(session.worktreePath);
      await control.killSession(session.name);
      return true;
    },
  };
}

export const runSessionPort: RunSessionPort = createRunSessionPort(resourceRegistryPort);
