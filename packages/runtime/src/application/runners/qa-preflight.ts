/**
 * Can this work item be verified on this machine?
 *
 * The verification agent is given the acceptance criteria and asked to settle
 * them. When the machine cannot run the criteria's own check commands, the
 * agent spends the whole round finding that out and the item ends as an
 * unexplained timeout.
 *
 * The preflight asks first. It only blocks on what is clearly missing from
 * the machine — a missing tool, a missing dependency, a missing runtime — so
 * a criterion that fails for any other reason is still the agent's to settle.
 */

import { extractAC } from '../../domain/tracker/ac.js';
import { toolRequirements } from '../../domain/tracker/ac-tools.js';
import { probeQaEnvironment } from '../../infrastructure/qa/environment-probe.js';
import type { EnvironmentBlocker } from '../../infrastructure/qa/environment-probe.js';

export interface QaPreflightOutcome {
  /** The round cannot run here. */
  blocked: boolean;
  /** Why, in words a person can act on. */
  summary?: string;
  blockers: EnvironmentBlocker[];
  inconclusive: EnvironmentBlocker[];
}

/**
 * Probe the environment for the tools the item's acceptance criteria need.
 *
 * An item whose criteria name no runnable command — every criterion is a
 * manual review — needs no probe: there is nothing to be missing.
 */
export async function runQaPreflight(
  item: { description?: string; tags?: string[] },
  worktreePath: string,
  options: { timeoutMs?: number } = {},
): Promise<QaPreflightOutcome> {
  const criteria = extractAC({ labels: item.tags ?? [], description: item.description ?? '' });
  const requirements = criteria.items
    .filter(item_ => item_.checkCommand.trim().length > 0)
    .flatMap(item_ => toolRequirements(item_.text, item_.checkCommand));

  if (requirements.length === 0) {
    return { blocked: false, blockers: [], inconclusive: [] };
  }

  const probe = await probeQaEnvironment(requirements, worktreePath, options);
  if (probe.blockers.length === 0) {
    return { blocked: false, blockers: [], inconclusive: probe.inconclusive };
  }

  const details = probe.blockers
    .map(blocker => `${blocker.tool} — ${blocker.detail} (criterion: ${blocker.criterion})`)
    .join('; ');
  return {
    blocked: true,
    summary: `the verification environment cannot run this item's acceptance criteria: ${details}`,
    blockers: probe.blockers,
    inconclusive: probe.inconclusive,
  };
}
