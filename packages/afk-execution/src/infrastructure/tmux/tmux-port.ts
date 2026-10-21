import type { TmuxPort } from '@afk/application';
import { TmuxClient } from './tmux.js';
import { agentReadiness } from './agent-readiness.js';

/**
 * The tmux sessions, reached through the port.
 *
 * A client is made per call: it holds the control-mode connection it
 * opened, and a connection left open past the command that wanted it is a
 * connection the next command inherits. The port is what a caller holds,
 * so the client it makes is not the caller's problem.
 */
export const tmuxPort: TmuxPort = {
  createSession: (name, dir, command) => new TmuxClient().createSession(name, dir, command),
  hasSession: (name) => new TmuxClient().hasSession(name),
  killSession: (name) => new TmuxClient().killSession(name),
  sendPrompt: (worktreeDir, session, tmuxWindow, prompt, signalType, readiness) =>
    new TmuxClient().sendPrompt(worktreeDir, session, tmuxWindow, prompt, signalType, readiness),
  capturePane: (session, tmuxWindow, options) => new TmuxClient().capturePane(session, tmuxWindow, options),
  waitForSignal: (session, tmuxWindow, signalType, worktreeDir, timeout) =>
    new TmuxClient().waitForSignal(session, tmuxWindow, signalType, worktreeDir, timeout),
  attach: (session) => new TmuxClient().attach(session),
  readiness: (agent) => agentReadiness(agent),
};
