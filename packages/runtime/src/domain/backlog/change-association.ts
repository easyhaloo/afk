/**
 * Which change request belongs to a backlog item.
 *
 * One source branch can carry more than one change request: a probe that was
 * aimed at another branch, a retry, a change that was opened by mistake. "The
 * first one the listing happens to return" is not an association — a listing
 * answers in groups of states, so the winner depends on how the platform
 * orders its answer rather than on the work itself. The association is a
 * decision with a rule, so the rule lives here and every caller shares it.
 */

/** What a candidate needs to be ranked: its identity, its state, where it goes. */
export interface ChangeAssociationCandidate {
  id: string;
  state: 'open' | 'merged' | 'closed';
  sourceBranch: string;
  targetBranch: string;
}

/**
 * Which change the caller is looking for.
 *
 * - `landed` — the change that has already landed. The books of an item are
 *   about the work that landed, so the reconciliation of a merged change
 *   wants this one.
 * - `alive` — the change that is still in flight. A person has to act on
 *   it, so the display of an item that waits for a person wants this one.
 *
 * The two are not the same question. A branch that was reworked carries the
 * change of the earlier round that has landed and the change of the current
 * round that is open. The books of a finished item are about the first; the
 * merge gate of an open item is about the second.
 */
export type ChangeAssociationIntent = 'landed' | 'alive';

export interface ChangeAssociationOptions {
  /**
   * The branch the change of the item is supposed to land on.
   *
   * A caller that knows where the work was headed says so here. Among the
   * changes that have not landed, the one aimed at that branch is the item's
   * own change; a change aimed elsewhere is something else.
   */
  preferredTargetBranch?: string;
  /**
   * Which change the caller is looking for.
   *
   * The default is `landed`: the change that has landed is the one the books
   * are about. A caller that waits for a person asks for the `alive` one.
   */
  intent?: ChangeAssociationIntent;
}

/**
 * How well a candidate answers "this is the item's change".
 *
 * For the change that has landed, the order is the rule, not an accident:
 *
 * 1. merged — the change that landed is the one the books are about.
 * 2. the expected target branch — among the changes that have not landed,
 *    the one aimed at the branch the work was headed for is this item's
 *    change.
 * 3. open — a change that is still in flight.
 * 4. anything else — a closed change still answers better than no change.
 *
 * For the change that is still alive the order is the mirror of it: a change
 * that is in flight comes first, because that is the one a person has to act
 * on, and a change that has landed is a fact about an earlier round.
 */
function associationRank(candidate: ChangeAssociationCandidate, options: ChangeAssociationOptions): number {
  const preferred = options.preferredTargetBranch;
  const targetsExpected = preferred !== undefined && candidate.targetBranch === preferred;
  if (options.intent === 'alive') {
    if (candidate.state === 'open') return targetsExpected ? 4 : 3;
    if (targetsExpected) return 2;
    if (candidate.state === 'merged') return 1;
    return 0;
  }
  if (candidate.state === 'merged') return 4;
  if (targetsExpected) return 3;
  if (candidate.state === 'open') return 2;
  return 0;
}

/**
 * The order a change request number counts in.
 *
 * The number says which change is the newer one. A candidate whose id is not
 * a number cannot be ordered against one that is, so it keeps its place.
 */
function changeNumber(id: string): number {
  const value = Number(id);
  return Number.isSafeInteger(value) ? value : 0;
}

/**
 * The candidates, strongest first.
 *
 * Within one strength the newer change comes first: the rule only says which
 * change is the item's, and the newest of those carries the current work.
 */
export function rankChangeAssociations(
  candidates: readonly ChangeAssociationCandidate[],
  options: ChangeAssociationOptions = {},
): ChangeAssociationCandidate[] {
  return [...candidates].sort((left, right) => {
    const byStrength = associationRank(right, options) - associationRank(left, options);
    if (byStrength !== 0) return byStrength;
    return changeNumber(right.id) - changeNumber(left.id);
  });
}

/**
 * The change request of a backlog item.
 *
 * Null when the branch carries no change at all. The caller has to say so
 * itself, because "there is no change" and "the wrong change was picked" are
 * different failures.
 */
export function selectChangeAssociation(
  candidates: readonly ChangeAssociationCandidate[],
  options: ChangeAssociationOptions = {},
): ChangeAssociationCandidate | null {
  return rankChangeAssociations(candidates, options)[0] ?? null;
}

/**
 * The changes that belong to a backlog item, split by the branch they sit on.
 */
export interface ChangeCandidateScope<T> {
  /** The changes that carry the work of the item. */
  scope: T[];
  /** The changes on the other branch of the item. */
  others: T[];
}

/**
 * The changes that carry the work of a backlog item.
 *
 * The verification branch is where the change of an item is published; the
 * branch of the item itself is the fallback for a change that was published
 * without one. The changes on the branch that was not taken are kept apart:
 * they are not the item's change, but they are the alternatives a person has
 * to know about.
 *
 * Both sides of the association scope the candidates here, so the one that
 * looks for the change that landed and the one that looks for the change
 * that is alive can never disagree about which changes belong to the item.
 */
export function scopeChangeCandidates<T extends { sourceBranch: string }>(
  candidates: readonly T[],
  branchName: string,
): ChangeCandidateScope<T> {
  const onVerification = candidates.filter(candidate => candidate.sourceBranch === `${branchName}-qa`);
  const onItem = candidates.filter(candidate => candidate.sourceBranch === branchName);
  return onVerification.length > 0
    ? { scope: onVerification, others: onItem }
    : { scope: onItem, others: [] };
}
