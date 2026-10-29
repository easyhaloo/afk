/**
 * The execution base a work item declares in its body.
 *
 * A branch is a property of a repository, not of the backlog: the same branch
 * name means nothing in another repository, and a label would carry that
 * meaning across every repository the credentials can reach. The body is
 * where the fact belongs — it is the one place a person writes it down and
 * an agent reads it.
 *
 * The block AFK reads is:
 *
 * ```text
 * ## Base Version
 *
 * - Base Ref: 2025-11-8-show
 * ```
 *
 * A repository whose default branch is not the one the work starts from has
 * to say so, because the provider's default branch is a setting of the
 * repository and not a statement about this piece of work.
 */

/** The heading that opens the base version block. */
export const BASE_VERSION_HEADING = '## Base Version';

/** The label that names the ref inside the block. */
export const BASE_REF_LABEL = 'Base Ref';

/**
 * Render the base version block for a work item body.
 *
 * The block goes in front of the body, so it reads as a fact about the work
 * rather than as a footnote appended to it.
 */
export function renderBaseVersionSection(baseBranch: string): string {
  return `${BASE_VERSION_HEADING}\n\n- ${BASE_REF_LABEL}: ${baseBranch}\n`;
}

/**
 * The base ref a work item declares, or undefined when it declares none.
 *
 * Only the block named "Base Version" is read. A mention of a branch anywhere
 * else in the body is prose, not a declaration — the acceptance criteria of a
 * work item talk about branches often.
 */
export function parseExecutionBaseBranch(description?: string): string | undefined {
  if (!description) return undefined;
  let inBaseVersion = false;
  for (const line of description.split(/\r?\n/)) {
    const heading = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (heading) {
      inBaseVersion = heading[2].trim().toLowerCase() === 'base version';
      continue;
    }
    if (!inBaseVersion) continue;
    const ref = /^[-*]\s*Base\s+Ref\s*:\s*(\S+)\s*$/i.exec(line.trim());
    if (ref) return ref[1];
  }
  return undefined;
}

/**
 * Put a base ref into a work item body, replacing the block it already has.
 *
 * A body that declares no base ref keeps its text; a body that declares one
 * is rewritten in place, so the block never appears twice.
 */
export function applyExecutionBaseBranch(description: string, baseBranch: string): string {
  const section = renderBaseVersionSection(baseBranch);
  const lines = description.split(/\r?\n/);
  const kept: string[] = [];
  let inBaseVersion = false;
  let replaced = false;
  for (const line of lines) {
    const heading = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (heading) {
      if (inBaseVersion && !replaced) {
        kept.push(section.trimEnd());
        replaced = true;
      }
      inBaseVersion = heading[2].trim().toLowerCase() === 'base version';
      kept.push(line);
      continue;
    }
    if (inBaseVersion) continue;
    kept.push(line);
  }
  if (inBaseVersion && !replaced) {
    kept.push(section.trimEnd());
    replaced = true;
  }
  const body = kept.join('\n').trimEnd();
  if (replaced) return `${body}\n`;
  return `${body}\n\n${section}`;
}
