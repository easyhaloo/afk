/**
 * The closing references a merge request description carries.
 *
 * A platform resolves the references in a description into a link between the
 * merge request and the issue it closes — but only for a merge request that
 * targets the default branch of its project. A change that has to land on a
 * release branch never gets that link, even though the description names the
 * issue it closes.
 *
 * The description is the evidence in that case, and it is the evidence AFK
 * wrote: the reference says which project and which issue the change closes.
 * Reading it back proves the merge request points at the work item AFK meant
 * it to — including the cross-repository spelling, where the project has to
 * be named.
 */

/** One closing reference, as the description spells it. */
export interface ClosingReference {
  /** The project the reference names, when it names one. */
  projectPath?: string;
  /** The issue number the reference names. */
  issueNumber: number;
}

/** The verbs a platform treats as "this change closes that issue". */
const CLOSING_VERBS = 'closes|closed|close|fixes|fixed|fix|resolves|resolved|resolve';

const REFERENCE_PATTERN = new RegExp(
  `\\b(?:${CLOSING_VERBS})\\s+(?:([A-Za-z0-9_./-]+(?::[A-Za-z0-9_./-]+)?)\\s*)?#(\\d+)`,
  'gi',
);

/**
 * Every closing reference a description carries.
 *
 * A reference without a project names an issue of the project the change
 * belongs to, which is the spelling a platform reads as well.
 */
export function closingReferences(description?: string): ClosingReference[] {
  if (!description) return [];
  const references: ClosingReference[] = [];
  for (const match of description.matchAll(REFERENCE_PATTERN)) {
    const issueNumber = Number(match[2]);
    if (!Number.isSafeInteger(issueNumber) || issueNumber <= 0) continue;
    references.push({ ...(match[1] ? { projectPath: match[1] } : {}), issueNumber });
  }
  return references;
}

/**
 * True when a description closes the given issue of the given project.
 *
 * A reference without a project counts for the project the change belongs
 * to, which is what a platform reads. A named project has to be the one the
 * issue lives in.
 */
export function closesIssue(
  description: string | undefined,
  issueNumber: number,
  projectPath: string,
): boolean {
  return closingReferences(description).some(reference =>
    reference.issueNumber === issueNumber
    && (!reference.projectPath || sameProject(reference.projectPath, projectPath)));
}

/** True when two project paths name the same repository. */
function sameProject(left: string, right: string): boolean {
  const normalize = (value: string) => value.trim().replace(/\.git$/, '').toLowerCase();
  const a = normalize(left);
  const b = normalize(right);
  if (a === b) return true;
  // A reference may name the project by its last segment only.
  const tail = (value: string) => value.slice(value.lastIndexOf('/') + 1);
  return tail(a) === tail(b);
}
