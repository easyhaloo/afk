/**
 * Planning a revision of the body of a backlog item.
 *
 * The body of an item is where the contract it carries is written down: the
 * acceptance criteria a reviewer checks the work against, the context that
 * explains why the work exists, the dependencies that bound it. A contract
 * that changes has to be written into the body of the item that carries it,
 * or a reviewer reads the old contract and judges the new work against it.
 *
 * AFK manages a few parts of that body itself: the base ref the work starts
 * from, the links a reader follows, the baseline a PRD accumulates its slices
 * on, and the retry marker that stops a repeated creation from making a second
 * record. A revision replaces the body wholesale, so it can drop those parts
 * by accident — a body written by hand carries the parts its author
 * remembered.
 *
 * So a revision is planned before it is written. The plan reports the managed
 * parts that are missing and the ones the revision would remove, and the
 * revision writes exactly the body it was given: a managed part that is gone
 * is AFK's to restore deliberately, never the revision's to invent silently.
 */

import { idempotencyMarkerIn } from './idempotency.js';

/** The body sections AFK writes into an item and reads back. */
export const MANAGED_BODY_SECTIONS = ['Base Version', 'Backlog Links', 'Baseline Branch'] as const;

/** How one section of a body changed. */
export type DescriptionSectionStatus = 'added' | 'removed' | 'modified';

/** One section of a body, and what the revision did to it. */
export interface DescriptionSectionChange {
  /** The heading of the section; empty for the text before the first heading. */
  heading: string;
  status: DescriptionSectionStatus;
}

/**
 * What a revision of a body changes, and what it risks.
 *
 * It is the whole answer of a dry run: the sections that changed, and the
 * managed parts that are missing or would be removed.
 */
export interface DescriptionRevisionPlan {
  /** Whether the revision changes the body at all. */
  changed: boolean;
  /** The length of the body the revision replaces. */
  currentLength: number;
  /** The length of the body the revision writes. */
  nextLength: number;
  /** The sections that were added, removed or rewritten. */
  sections: DescriptionSectionChange[];
  /** The managed sections the body does not carry. */
  missingManagedSections: string[];
  /** The managed sections the revision would remove from the body. */
  droppedManagedSections: string[];
  /** Whether the revision would remove the marker that identifies the record. */
  dropsRetryMarker: boolean;
}

/**
 * The sections of a body, keyed by their heading.
 *
 * A body is Markdown, and its sections are the `##` headings it opens. The
 * text before the first heading is a section of its own, because a body may
 * carry a paragraph before the sections a reader looks for.
 */
function bodySections(description: string): Map<string, string> {
  const sections = new Map<string, string>();
  let heading = '';
  let content: string[] = [];
  const flush = (): void => {
    sections.set(heading, content.join('\n').trim());
  };
  for (const line of description.split(/\r?\n/)) {
    const match = /^##\s+(.+?)\s*$/.exec(line);
    if (match) {
      flush();
      heading = match[1].trim();
      content = [];
      continue;
    }
    content.push(line);
  }
  flush();
  return sections;
}

/** The managed sections a body carries. */
export function managedSectionsOf(description: string): string[] {
  const sections = bodySections(description);
  return MANAGED_BODY_SECTIONS.filter(section => sections.has(section));
}

/**
 * The managed sections an item of this shape is supposed to carry.
 *
 * Not every item carries every managed section: a slice that starts from a
 * release ref declares its base, a PRD anchor accumulates its slices on a
 * baseline, and every body AFK writes links back to the item itself. A section
 * an item was never supposed to carry is not missing from it.
 */
export function expectedManagedSections(item: { kind?: string; executionBase?: string }): string[] {
  return [
    'Backlog Links',
    ...(item.executionBase ? ['Base Version'] : []),
    ...(item.kind === 'prd' ? ['Baseline Branch'] : []),
  ];
}

/**
 * Plan the revision of one body.
 *
 * The plan never rebuilds anything: it only says what the revision changes
 * and what AFK-managed parts are at stake.
 */
export function planDescriptionRevision(
  current: string,
  next: string,
  expected: readonly string[] = MANAGED_BODY_SECTIONS,
): DescriptionRevisionPlan {
  const currentSections = bodySections(current);
  const nextSections = bodySections(next);
  const sections: DescriptionSectionChange[] = [];
  for (const [heading, content] of nextSections) {
    if (!currentSections.has(heading)) sections.push({ heading, status: 'added' });
    else if (currentSections.get(heading) !== content) sections.push({ heading, status: 'modified' });
  }
  for (const heading of currentSections.keys()) {
    if (!nextSections.has(heading)) sections.push({ heading, status: 'removed' });
  }
  const managed = managedSectionsOf(current);
  return {
    changed: current.trim() !== next.trim(),
    currentLength: current.length,
    nextLength: next.length,
    sections,
    missingManagedSections: expected.filter(section => !managed.includes(section)),
    droppedManagedSections: managed.filter(section => !nextSections.has(section)),
    dropsRetryMarker: idempotencyMarkerIn(current) !== undefined
      && idempotencyMarkerIn(next) === undefined,
  };
}
