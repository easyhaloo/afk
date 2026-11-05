/**
 * A PRD accumulates its slices on a branch of its own.
 *
 * The repository's integration line is where that branch was cut from; it is
 * not where the slices land. Every slice of a PRD is written on the PRD's
 * baseline branch and merges into it, and the baseline branch merges into the
 * integration line once the whole PRD is done. A repository can therefore hold
 * several PRDs at once, each with its own accumulation branch.
 *
 * The branch name follows the repository convention `prd/<issue number>`, so
 * the same PRD uses the same branch name in every repository it touches. A PRD
 * that needs a different name declares it in its body:
 *
 * ```text
 * ## Baseline Branch
 *
 * - Baseline Ref: prd/27
 * ```
 */

import { createExecutionPlan, executionRef, type ExecutionPlan } from './execution-plan.js';

/** The section a PRD declares its baseline branch in. */
export const PRD_BASELINE_SECTION = 'Baseline Branch';

/** The heading that opens the section. */
export const PRD_BASELINE_HEADING = `## ${PRD_BASELINE_SECTION}`;

/** The label that names the branch inside the section. */
export const PRD_BASELINE_LABEL = 'Baseline Ref';

/** The prefix of a conventionally named PRD baseline branch. */
export const PRD_BASELINE_BRANCH_PREFIX = 'prd/';

/**
 * The parent facts the baseline rule reads.
 *
 * A parent is read from two places — the provider and the global inventory —
 * and both carry the same three facts: what it is, which issue it is, and
 * what its body says.
 */
export interface PrdBaselineParent {
  /** The canonical identity, whose issue number names the branch. */
  id?: string;
  /** The issue number, when the reader already knows it. */
  issueNumber?: number;
  /** The role of the parent; `prd` marks a PRD anchor. */
  kind?: 'prd';
  /** The body the parent may declare its baseline branch in. */
  description?: string;
}

/**
 * The branch name a PRD accumulates on.
 *
 * The number is the PRD's own issue number, so the name is the same in every
 * repository the PRD touches.
 */
export function prdBaselineBranchName(issueNumber: number | string): string {
  const value = String(issueNumber ?? '').trim();
  if (!/^\d+$/.test(value)) throw new Error(`PRD issue number is invalid: ${issueNumber}`);
  return `${PRD_BASELINE_BRANCH_PREFIX}${value}`;
}

/**
 * The issue number a work item identity ends with.
 *
 * A canonical identity is `platform:projectKey#issueNumber`; a plain issue
 * number is the same fact without the rest of it.
 */
export function prdIssueNumber(id: string): number | undefined {
  const marker = id.lastIndexOf('#');
  const candidate = marker >= 0 ? id.slice(marker + 1) : id;
  return /^\d+$/.test(candidate) ? Number(candidate) : undefined;
}

/**
 * The baseline branch a PRD declares, or the conventional name when it
 * declares none.
 */
export function prdBaselineBranch(prd: { issueNumber: number; description?: string }): string {
  return parsePrdBaselineBranch(prd.description) ?? prdBaselineBranchName(prd.issueNumber);
}

/**
 * Parse the baseline branch a PRD declares in its body.
 *
 * Only the block named "Baseline Branch" is read. A mention of a branch
 * anywhere else in the body is prose, not a declaration — a PRD explains its
 * branches often.
 */
export function parsePrdBaselineBranch(description?: string): string | undefined {
  let inSection = false;
  let branch: string | undefined;
  for (const line of (description ?? '').split(/\r?\n/)) {
    const heading = /^#{1,6}\s+(.+?)\s*$/.exec(line);
    if (heading) {
      inSection = heading[1].trim().toLowerCase() === PRD_BASELINE_SECTION.toLowerCase();
      continue;
    }
    if (!inSection) continue;
    const match = /^[-*]\s*Baseline\s+Ref\s*:\s*(.*?)\s*$/i.exec(line.trim());
    if (!match) continue;
    const value = executionRef(match[1], PRD_BASELINE_LABEL);
    if (branch !== undefined && branch !== value) throw new Error('conflicting Baseline Ref declarations');
    branch = value;
  }
  return branch;
}

/**
 * The baseline a slice inherits from its parent, when the parent is a PRD.
 *
 * A slice that declares its own execution plan keeps it: an explicit
 * declaration is a statement about that one piece of work. A slice that
 * declares nothing inherits the PRD's baseline branch, which is what makes a
 * PRD's slices accumulate on one branch instead of scattering over the
 * repository's integration line.
 */
export function prdBaselineForParent(parent: PrdBaselineParent | undefined): string | undefined {
  if (!parent || parent.kind !== 'prd') return undefined;
  const issueNumber = parent.issueNumber ?? (parent.id ? prdIssueNumber(parent.id) : undefined);
  if (issueNumber === undefined) return undefined;
  return prdBaselineBranch({ issueNumber, description: parent.description });
}

/**
 * The baseline branch of the PRD a work item hangs under.
 *
 * A parent that cannot be read is an error rather than a fallback: quietly
 * using the repository's integration line would put the slice exactly where
 * the PRD baseline model says it must not go. Declaring the base explicitly in
 * the work item's own body is the way out.
 *
 * A caller that only reports — checking which branch a published change
 * targeted — asks for a lenient read instead: an unreadable parent there means
 * "nothing to inherit", not a reason to refuse the answer.
 */
export async function resolveParentPrdBaseline(
  parentId: string | undefined,
  get: (id: string) => Promise<PrdBaselineParent>,
  options: { required?: boolean } = {},
): Promise<string | undefined> {
  if (!parentId) return undefined;
  let parent: PrdBaselineParent;
  try {
    parent = await get(parentId);
  } catch (error) {
    if (options.required === false) return undefined;
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`work item ${parentId} cannot be read, so the baseline branch of its PRD cannot be resolved (${reason}); declare the base explicitly in the work item body instead`);
  }
  return prdBaselineForParent(parent);
}

/**
 * The plan a slice of a PRD runs on.
 *
 * The baseline branch is both where the work starts and where the work
 * merges into: the slice is one piece of the PRD, and the PRD's branch is
 * where the PRD accumulates. The functional source travels with the work and
 * says nothing about the baseline.
 */
export function prdBaselinePlan(prdBaseline: string, sourceRef?: string): ExecutionPlan {
  return createExecutionPlan({ baseRef: prdBaseline, targetRef: prdBaseline, sourceRef });
}

/**
 * The plan a work item runs on.
 *
 * A plan the caller already resolved always wins: it is either the item's own
 * declaration or the record of the run that is under way. The PRD's baseline
 * branch only fills the gap — it is what a slice inherits when it says
 * nothing itself. The repository's own defaults are the last resort.
 */
export function resolvePrdExecutionPlan(input: {
  /** The plan the caller resolved, when there is one. */
  plan?: ExecutionPlan;
  /** The baseline branch of the item's PRD parent. */
  prdBaseline?: string;
  /** The repository's own defaults. */
  fallback: ExecutionPlan;
}): ExecutionPlan {
  if (input.plan) return input.plan;
  if (input.prdBaseline) return prdBaselinePlan(input.prdBaseline, input.fallback.sourceRef);
  return input.fallback;
}

/** Render the baseline block for a PRD body. */
export function renderPrdBaselineSection(branch: string): string {
  return `${PRD_BASELINE_HEADING}\n\n- ${PRD_BASELINE_LABEL}: ${branch}\n`;
}

/**
 * Put a baseline branch into a PRD body, replacing the block it already has.
 *
 * A body that declares no baseline keeps its text; a body that declares one
 * is rewritten in place, so the block never appears twice.
 */
export function applyPrdBaselineBranch(description: string, branch: string): string {
  const section = renderPrdBaselineSection(executionRef(branch, PRD_BASELINE_LABEL));
  const lines = description.split(/\r?\n/);
  const kept: string[] = [];
  let inSection = false;
  let replaced = false;
  for (const line of lines) {
    const heading = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (heading) {
      if (inSection && !replaced) {
        kept.push(section.trimEnd());
        replaced = true;
      }
      inSection = heading[2].trim().toLowerCase() === PRD_BASELINE_SECTION.toLowerCase();
      if (!inSection) kept.push(line);
      continue;
    }
    if (inSection) continue;
    kept.push(line);
  }
  if (inSection && !replaced) {
    kept.push(section.trimEnd());
    replaced = true;
  }
  const body = kept.join('\n').trimEnd();
  if (replaced) return `${body}\n`;
  return `${body}\n\n${section}`;
}
