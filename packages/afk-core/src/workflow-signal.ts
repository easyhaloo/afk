/**
 * The signals a run leaves behind.
 *
 * A signal is how a run says what happened: the goal is complete, the
 * handoff document is ready, the wait ran out, the agent went quiet. The
 * runner writes one, the reader waits for one, the retro gathers them as
 * evidence, and the command that writes one has to agree with the file
 * format the reader accepts.
 *
 * The shapes live in the core package because the reader that validates a
 * signal file, the writer that produces one and the command that asks for
 * one are three different layers, and the vocabulary they share cannot live
 * in any one of them. The file format itself is checked by the schema in
 * the infrastructure package, which is written against these types.
 */

/**
 * The results a QA signal can carry.
 *
 * The list is named so the signal schema and the command that writes a
 * QA signal read the same answer. Writing the results down in each of
 * them meant the command refused a result the signal file accepted.
 */
export const GOAL_COMPLETE_RESULTS = ['PASS', 'FAIL'] as const;

export type GoalCompleteResult = (typeof GOAL_COMPLETE_RESULTS)[number];

export interface GoalCompleteSignal {
  type: 'goal_complete';
  timestamp: string;
  kind?: 'task' | 'qa' | 'ac_verification';
  result?: GoalCompleteResult;
  sha?: string;
  summary: string;
  tests_run?: number;
  tests_passed?: number;
  failedCriteria?: Array<{ id: string; expected: string; actual: string }>;
  requiredChecks?: Array<{ command: string; expected: string }>;
}

export interface HandoffReadySignal {
  type: 'handoff_ready';
  timestamp: string;
  summary: string;
}

export interface TimeoutSignal {
  type: 'timeout';
  timestamp: string;
}

export interface IdleSignal {
  type: 'idle';
  timestamp: string;
}

/** The signal a run may leave behind. */
export type Signal = GoalCompleteSignal | HandoffReadySignal | TimeoutSignal | IdleSignal;

/**
 * The signal types a signal file may carry.
 *
 * The list is the vocabulary: the schema that validates a signal file and
 * the command that writes one read the same answer, so a signal the writer
 * produces is never one the reader refuses.
 */
export const SIGNAL_TYPES = ['goal_complete', 'handoff_ready', 'timeout', 'idle'] as const;

export type SignalType = (typeof SIGNAL_TYPES)[number];
