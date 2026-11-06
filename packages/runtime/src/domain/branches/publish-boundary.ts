/**
 * Who owns which branch.
 *
 * AFK hands an agent a repository with several branches in it and tells it
 * which one to work on. That was never enough. The same instruction also
 * named the branch the change request will be merged into, and an agent
 * that read "publish to prd/27" as "push to prd/27" advanced the PRD
 * baseline with its own commit.
 *
 * The damage was not the extra commit. It was what happened next. The
 * change request had nothing left to merge, so the platform reported it as
 * unmergeable; AFK read that as a conflict, sent the item back for another
 * round, and the next round pushed the baseline again. The loop had no end,
 * because the thing AFK called a conflict was not a conflict at all — it
 * was AFK's own agent moving AFK's own baseline.
 *
 * The boundary is the rule that makes the loop impossible:
 *
 * - the agent owns the **working branch** and nothing else. It commits
 *   there and pushes there.
 * - the **base branch** and the **target branch** belong to AFK's change
 *   request. They are read, never pushed. AFK is the only thing that moves
 *   them.
 *
 * The rule is stated to the agent in words, and it is enforced by AFK
 * afterwards: a change request whose target branch already carries the
 * change is not a conflict but a baseline that advanced, and a baseline
 * that advanced is escalated to a person instead of being answered with
 * another round of work.
 */

import type { ChangeMergeState } from '../tracker/types.js';

/**
 * The branches of one execution, and who owns each of them.
 */
export interface PublishBoundary {
  /** The branch the agent works on, commits to and pushes. Its own. */
  readonly workingBranch: string;
  /** The branch the change request is merged into. AFK's to move. */
  readonly targetBranch: string;
  /** The branch the work is based on. AFK's to read. */
  readonly baseBranch: string;
  /** The branch the feature is taken from, when the item names one. */
  readonly sourceBranch?: string;
}

/**
 * The branches the agent must not push to.
 *
 * The target and the base are the same branch more often than not — a PRD
 * slice is based on the PRD baseline and merged into it — so the list is
 * deduplicated before it is shown.
 */
export function reservedBranches(boundary: PublishBoundary): string[] {
  return [...new Set([boundary.targetBranch, boundary.baseBranch, boundary.sourceBranch]
    .filter((branch): branch is string => typeof branch === 'string' && branch.length > 0))];
}

/**
 * The instruction that tells the agent where the boundary is.
 *
 * It says which branch is the agent's, and it says the others are not — by
 * name, so the agent does not have to guess which of the branches in the
 * repository it may move.
 */
export function describePublishBoundary(boundary: PublishBoundary): string {
  const reserved = reservedBranches(boundary);
  const reservedText = reserved.join(', ');
  const pronoun = reserved.length === 1 ? 'it' : 'them';
  const verb = reserved.length === 1 ? 'belongs' : 'belong';
  const ownership = reserved.length === 0
    ? 'The base branch and the target branch of the change request belong to AFK: read them, never push to them.'
    : `${reservedText} ${verb} to AFK's change request: read ${pronoun}, never push to ${pronoun}.`;
  return [
    `Branch ownership: ${boundary.workingBranch} is yours — commit and push only there.`,
    ownership,
    'AFK publishes the change request itself, and it stops the run when it finds the target branch moved.',
  ].join(' ');
}

/**
 * What AFK does about a published change request's merge verdict.
 *
 * The three answers are deliberately different, because the three facts are
 * different:
 *
 * - `accept` — the change request can land. Hand it to a person to merge.
 * - `rework` — the content conflicts. Another round of work can resolve
 *   it, because the content is what went wrong.
 * - `escalate` — the target branch moved and there is nothing left to
 *   merge. Another round of work cannot resolve it: the work is already in
 *   the baseline, and doing it again would push the baseline again. A
 *   person has to decide whether the baseline keeps the commits or is
 *   rolled back.
 */
export type MergeVerdictAction = 'accept' | 'rework' | 'escalate';

/**
 * The action a merge verdict calls for.
 *
 * An unknown verdict is accepted: the platform has not settled on one, or
 * it named a reason that is not a conflict. Neither is a reason to send
 * the item back.
 */
export function decideMergeVerdict(state: ChangeMergeState | undefined): MergeVerdictAction {
  switch (state) {
    case 'conflict': return 'rework';
    case 'baseline_advanced': return 'escalate';
    default: return 'accept';
  }
}
