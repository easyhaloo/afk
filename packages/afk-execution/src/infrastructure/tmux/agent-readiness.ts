import { promises as fs } from 'node:fs';
import { statusFilePath } from '@afk/infrastructure';
import type { AgentProviderName } from '../../domain/agents/types.js';

/**
 * What the agent has to show before it can be driven.
 */
export type ReadinessContext = {
  /** The worktree the agent runs in. */
  worktreeDir: string;
  /** The tmux session, when the agent runs in one. */
  session?: string;
  /** Whether the tmux session exists — the tmux client's own answer. */
  sessionExists: (session: string) => Promise<boolean>;
};

/**
 * How one agent says it is up.
 *
 * The tmux session exists as soon as the shell does, which is not the same
 * as the agent being ready: the CLI has to start, and a prompt typed into a
 * shell that has not started the agent is a prompt nobody sees.
 */
export type AgentReadiness = {
  /** The agent the rule is about, for the message when it never comes up. */
  agent: AgentProviderName;
  /** Whether the agent is up yet. */
  ready: (context: ReadinessContext) => Promise<boolean>;
};

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
