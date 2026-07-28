import type { TrackerProvider } from './core/tracker/types';
import { logAndReturn } from './cli-utils';

export interface PreconditionResult {
  ok: boolean;
  reason?: string;
}

/**
 * Check if an issue satisfies all preconditions for autonomous implementation.
 *
 * Checks:
 * 1. AC section exists in issue description
 * 2. base:: label exists (base::prd-N or base::direct)
 * 3. No open blockers (issues labeled blocks-<iid>)
 */
export async function checkIssuePreconditions(
  tracker: TrackerProvider,
  iid: number
): Promise<PreconditionResult> {
  try {
    const issue = await tracker.getIssue(iid);

    // 1. AC items must exist (labels or legacy markdown section)
    const ac = tracker.parseAC(issue);
    if (ac.items.length === 0) {
      return { ok: false, reason: 'missing AC (add ac::1::... labels or ## AC markdown section)' };
    }

    // 2. base:: label must exist
    const hasBase = issue.labels.some(l => /^base::(prd-\d+|direct)$/.test(l));
    if (!hasBase) {
      return { ok: false, reason: 'missing base:: label' };
    }

    // 3. No open blockers
    const blockers = await tracker.listIssues({
      labels: [`blocks-${iid}`],
      state: 'opened',
    });
    if (blockers.length > 0) {
      return { ok: false, reason: `${blockers.length} open blocker(s)` };
    }

    return { ok: true };
  } catch (error) {
    return logAndReturn(error, 'Error checking preconditions', { ok: false, reason: `error: ${(error as Error).message}` });
  }
}
