import { evaluateRunnability, type Runnability } from '../../domain/backlog/runnability.js';
import type { GlobalWorkItem } from '../../domain/work-item/types.js';

/**
 * Explain, for every item in a collected inventory, whether it may start.
 *
 * A collected inventory holds every item the credentials can reach, so the
 * dependencies and the children of an item are already in it: the answer
 * needs no further provider round trips, and every item is judged against
 * the same snapshot. An inventory that is missing a dependency judges that
 * dependency as unfinished, which is the safe direction — an item whose
 * dependency is not in view waits rather than runs.
 */
export function explainRunnabilityInInventory(items: readonly GlobalWorkItem[]): Map<string, Runnability> {
  const byId = new Map(items.map(item => [String(item.id), item]));
  const childCounts = new Map<string, number>();
  for (const item of items) {
    const parentId = item.parentId === undefined ? undefined : String(item.parentId);
    if (parentId === undefined) continue;
    childCounts.set(parentId, (childCounts.get(parentId) ?? 0) + 1);
  }
  const result = new Map<string, Runnability>();
  for (const item of items) {
    const id = String(item.id);
    result.set(id, evaluateRunnability({
      container: item.kind === 'prd',
      state: item.state,
      executionMode: item.executionMode,
      executionEligible: item.executionEligible,
      hasChildren: (childCounts.get(id) ?? 0) > 0,
      dependencies: item.dependsOn.map(dependencyId => ({
        id: String(dependencyId),
        state: byId.get(String(dependencyId))?.state,
      })),
    }));
  }
  return result;
}
