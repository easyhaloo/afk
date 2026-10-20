/**
 * The identity of a run's session.
 *
 * A session is named after the work item and the generation it belongs to:
 * `issue-<iid>-gen-<n>`, or `issue-<iid>-terminal` for the handoff that ends
 * the work item. The handoff document that holds it is named after the same
 * thing in a shorter spelling: `handoff-<iid>-<n>.md`.
 *
 * Both spellings, and both directions, are here. The coordinator writes the
 * document and the session store reads it; the runner writes the run id and
 * the store reads it back. Written out in each place, the two sides of a
 * convention drift apart without a compiler noticing.
 */
export type RunIdentity = {
  /** The work item's number, as it appears in the name. */
  iid: string;
  /** The generation, or 'terminal' for the handoff that ends the work item. */
  generation: number | 'terminal';
};

const RUN_ID_PATTERN = /^issue-(\d+)-(gen-(\d+)|terminal)$/;
const HANDOFF_DOC_PATTERN = /^handoff-(\d+)-(\d+|terminal)\.md$/;

/** The run id of a session. */
export function runIdFor(identity: RunIdentity): string {
  return identity.generation === 'terminal'
    ? `issue-${identity.iid}-terminal`
    : `issue-${identity.iid}-gen-${identity.generation}`;
}

/** The identity a run id names, when it names one. */
export function parseRunId(runId: string): RunIdentity | undefined {
  const match = RUN_ID_PATTERN.exec(runId);
  if (!match) return undefined;
  return { iid: match[1], generation: match[3] ? Number(match[3]) : 'terminal' };
}

/** The name of the handoff document that holds a session. */
export function handoffDocName(identity: RunIdentity): string {
  return identity.generation === 'terminal'
    ? `handoff-${identity.iid}-terminal.md`
    : `handoff-${identity.iid}-${identity.generation}.md`;
}

/** The identity a handoff document names, when it names one. */
export function parseHandoffDocName(name: string): RunIdentity | undefined {
  const match = HANDOFF_DOC_PATTERN.exec(name);
  if (!match) return undefined;
  return { iid: match[1], generation: match[2] === 'terminal' ? 'terminal' : Number(match[2]) };
}
