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

export interface ChangeAssociationOptions {
  /**
   * The branch the change of the item is supposed to land on.
   *
   * A caller that knows where the work was headed says so here. Among the
   * changes that have not landed, the one aimed at that branch is the item's
   * own change; a change aimed elsewhere is something else.
   */
  preferredTargetBranch?: string;
}

/**
 * How well a candidate answers "this is the item's change".
 *
 * The order is the rule, not an accident:
 *
 * 1. merged — the change that landed is the one the books are about.
 * 2. the expected target branch — among the changes that have not landed,
 *    the one aimed at the branch the work was headed for is this item's
 *    change.
 * 3. open — a change that is still in flight.
 * 4. anything else — a closed change still answers better than no change.
 */
function associationRank(candidate: ChangeAssociationCandidate, preferredTargetBranch?: string): number {
  if (candidate.state === 'merged') return 3;
  if (preferredTargetBranch !== undefined && candidate.targetBranch === preferredTargetBranch) return 2;
  if (candidate.state === 'open') return 1;
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
    const byStrength = associationRank(right, options.preferredTargetBranch) - associationRank(left, options.preferredTargetBranch);
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
