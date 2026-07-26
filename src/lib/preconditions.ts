import { GitLabClient } from './gitlab.js';

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
  gitlab: GitLabClient,
  iid: number
): Promise<PreconditionResult> {
  try {
    const issue = await gitlab.getIssue(iid);

    // 1. AC section must exist
    const ac = gitlab.parseAC(issue.description);
    if (!ac) {
      return { ok: false, reason: 'missing AC section' };
    }
    if (ac.items.length === 0) {
      return { ok: false, reason: 'AC section is empty' };
    }

    // 2. base:: label must exist
    const hasBase = issue.labels.some(l => /^base::(prd-\d+|direct)$/.test(l));
    if (!hasBase) {
      return { ok: false, reason: 'missing base:: label' };
    }

    // 3. No open blockers
    const blockers = await gitlab.listIssues({
      labels: [`blocks-${iid}`],
      state: 'opened',
    });
    if (blockers.length > 0) {
      return { ok: false, reason: `${blockers.length} open blocker(s)` };
    }

    return { ok: true };
  } catch (error) {
    return { ok: false, reason: `error: ${(error as Error).message}` };
  }
}
