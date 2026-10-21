/**
 * How an agent run executes.
 *
 * The interactive mode runs the agent in a tmux session, so a person can
 * attach to it and a run can hand the work over to a fresh session. The
 * batch mode is the headless one.
 *
 * This is not the same thing as the execution mode a work item carries.
 * A work item says who drives it - AFK or a human. An agent run says how
 * the agent process is hosted. The two names used to be the same name,
 * which is how a board ended up asking one question with two answers.
 *
 * The list lives in the core package because the audit spine records the
 * mode, the execution runtime drives it, the CLI asks for it and the
 * desktop client reads it. The lowest layer is the only place all of them
 * can reach, so it is the only place the list can be written down once.
 */
export const AGENT_EXECUTION_MODES = ['interactive', 'batch'] as const;

export type AgentExecutionMode = (typeof AGENT_EXECUTION_MODES)[number];

/** Whether a value names an execution mode an agent run can use. */
export function isAgentExecutionMode(value: unknown): value is AgentExecutionMode {
  return typeof value === 'string' && (AGENT_EXECUTION_MODES as readonly string[]).includes(value);
}
