/**
 * Correcting a rework record to the current fact.
 *
 * A rework record is AFK's own statement about what is wrong with an item.
 * It is written when a round fails, and it is read back to the next agent as
 * the context of that round. A statement can go stale: the dependency it
 * waited for has since been produced, the branch it complained about has
 * since moved, and the merge conflict it described is not a conflict at all.
 *
 * AFK could create a record and supersede it with the next round, but it
 * could not correct one. A frozen statement is read as a present fact, and
 * the agent acts on it — which is how a stale "merge the target branch into
 * the current branch" once turned into an agent pushing a branch it did not
 * own.
 *
 * Two rules make a correction safe:
 *
 * - **Only the statement is corrected.** The evidence a record carries —
 *   the failed criteria and the required checks — is what the verification
 *   actually observed. It is never rewritten and never dropped, because a
 *   correction says "this is still true today", not "this was never true".
 * - **A correction is a fact, not an instruction.** It says what is the
 *   case. It never says what to do, and in particular it never names a
 *   branch as the destination of a push.
 */

import type { ReworkRecord, ReworkRevision } from './rework-record.js';

/** What a correction says, and who says it. */
export interface ReworkRevisionInput {
  /** The fact statement that replaces the record's summary. */
  summary: string;
  /** Why the statement is being corrected. */
  reason?: string;
  /** Who is correcting it. */
  actor: string;
  /** When the correction is made. Defaults to now. */
  at?: string;
}

/**
 * The directives a correction may not contain.
 *
 * This is a denylist of the concrete shapes that caused the incident, not a
 * general detector of imperatives: a general detector cannot tell "把依赖写成了 label" (a fact) from "把 prd/27 合进当前分支" (an instruction) without parsing the sentence, and a rule that guesses would refuse honest statements.
 */
const FORBIDDEN_DIRECTIVES: ReadonlyArray<{ pattern: RegExp; why: string }> = [
  {
    // "publish to prd/27" is what an agent read as "push to prd/27".
    pattern: /\b(?:git\s+)?(?:force-)?(?:push|publish)\b[^.!?;\n]{0,40}\b[\w.-]+\/[\w./-]+/i,
    why: 'it names a branch as the destination of a push or a publish',
  },
  {
    pattern: /\b(?:force-)?(?:push|publish)\s+to\s+(?:the\s+)?[\w.-]+\b/i,
    why: 'it names a branch as the destination of a push',
  },
  {
    pattern: /(?:发布|推送|上传|提交|推)\s*(?:到|至)/,
    why: 'it names a destination for a push or a publish',
  },
  {
    // "把 prd/27 合进当前分支" is the other half of the same incident.
    pattern: /(?:把|将)[^。！？；\n]{0,30}[\w.-]+\/[\w./-]+[^。！？；\n]{0,12}(?:合进|合入|合并到|合并进|并入|推到|推送到|发布到|发布至)/,
    why: 'it names a branch as the source of a merge or a push',
  },
  {
    pattern: /(?:合|并)(?:进|入|到|过)[^。！？；\n]{0,8}当前分支/,
    why: 'it directs a branch to be merged into the current branch',
  },
  {
    // The base form only: "merged into" describes what happened.
    pattern: /\bmerge\b[^.!?;\n]{0,40}\binto\b/i,
    why: 'it directs a branch to be merged into another branch',
  },
  {
    pattern: /\bgit\s+(?:push|merge|rebase|cherry-pick|reset|revert)\b/i,
    why: 'it carries a git command that moves a branch',
  },
  {
    pattern: /\b(?:afk\s+backlog\s+(?:confirm-merge|retry)|glab\s+(?:api|mr\s+merge))\b/i,
    why: 'it carries a command that merges or re-runs work',
  },
];

/**
 * The directive a statement contains, if it contains one.
 *
 * @returns why the statement is refused, or undefined when it is a fact.
 */
export function findActionInstruction(text: string): string | undefined {
  for (const directive of FORBIDDEN_DIRECTIVES) {
    if (directive.pattern.test(text)) return directive.why;
  }
  return undefined;
}

/**
 * Refuse a correction that is not a fact statement.
 *
 * @throws when the statement is empty or carries a directive.
 */
export function assertFactStatement(text: string): string {
  const value = text.trim();
  if (!value) throw new Error('the revised summary must not be empty');
  const directive = findActionInstruction(value);
  if (directive) {
    throw new Error(
      `the revised summary must state a fact, not an instruction: ${directive}. `
      + 'Say what is the case now, not what the agent should do.',
    );
  }
  return value;
}

/**
 * The record as it reads after the correction.
 *
 * The identity of the record is kept: it is the same round of work, the same
 * attempt, the same evidence. Only the statement about the current situation
 * changes, and the correction is appended to the record's own trail, so the
 * previous statement is still readable.
 */
export function planReworkRevision(record: ReworkRecord, input: ReworkRevisionInput): ReworkRecord {
  const summary = assertFactStatement(input.summary);
  const actor = input.actor.trim();
  if (!actor) throw new Error('a rework revision must name who wrote it');
  const reason = input.reason?.trim();
  const revision: ReworkRevision = {
    at: input.at ?? new Date().toISOString(),
    actor,
    from: record.summary,
    to: summary,
    ...(reason ? { reason } : {}),
  };
  return {
    ...record,
    summary,
    revisions: [...(record.revisions ?? []), revision],
  };
}
