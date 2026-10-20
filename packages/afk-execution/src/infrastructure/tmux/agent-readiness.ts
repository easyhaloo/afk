import { promises as fs } from 'node:fs';
import { statusFilePath } from '@afk/infrastructure';
import type { AgentProviderName } from '../../domain/agents/types.js';
import type { AgentReadiness, ReadinessContext } from '../../domain/tmux/types.js';

export type { AgentReadiness, ReadinessContext };

/**
 * Claude Code's statusline writes its payload on the first turn, and the
 * payload's arrival is the marker that the CLI is up.
 */
async function statuslineWritten(context: ReadinessContext): Promise<boolean> {
  try {
    await fs.access(statusFilePath(context.worktreeDir));
    return true;
  } catch {
    return false;
  }
}

/**
 * The other agents write no marker AFK knows of, so their readiness is the
 * session's existence.
 */
async function sessionIsThere(context: ReadinessContext): Promise<boolean> {
  if (!context.session) return true;
  return context.sessionExists(context.session);
}

/**
 * How each agent says it is up.
 *
 * The rule belongs to the agent, not to the tmux wrapper: a wrapper that
 * knows which agents exist is a wrapper that has to be changed every time
 * the roster does.
 */
export function agentReadiness(agent: AgentProviderName): AgentReadiness {
  return agent === 'claude-code'
    ? { agent, ready: statuslineWritten }
    : { agent, ready: sessionIsThere };
}
