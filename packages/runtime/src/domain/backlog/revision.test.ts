import { describe, expect, it } from 'vitest';
import { expectedManagedSections, managedSectionsOf, planDescriptionRevision } from './revision.js';
import { idempotencyMarker, idempotencyMarkerComment } from './idempotency.js';

const BODY = `## Context

The work is cut from a release ref.

## Acceptance Criteria

- [ ] the change is deployed

## Backlog Links

- This backlog: [#42](https://gitlab.example/issues/42)
`;

describe('planning a revision of a body', () => {
  it('reports the sections a revision changed', () => {
    const next = BODY.replace('- [ ] the change is deployed', '- [ ] the change is deployed and verified');

    const plan = planDescriptionRevision(BODY, next);

    expect(plan.changed).toBe(true);
    expect(plan.sections).toEqual([{ heading: 'Acceptance Criteria', status: 'modified' }]);
  });

  it('reports a section a revision adds and a section it removes', () => {
    const next = `${BODY}\n## Notes\n\nA note.\n`;

    const plan = planDescriptionRevision(BODY, next);

    expect(plan.sections).toEqual([{ heading: 'Notes', status: 'added' }]);
  });

  it('names the managed sections a revision would remove', () => {
    const next = '## Context\n\nThe work is cut from a release ref.\n';

    const plan = planDescriptionRevision(BODY, next, ['Backlog Links']);

    expect(plan.droppedManagedSections).toEqual(['Backlog Links']);
    expect(plan.missingManagedSections).toEqual([]);
  });

  it('names the managed sections a body does not carry', () => {
    const plan = planDescriptionRevision('## Context\n\nOnly prose.\n', '## Context\n\nOnly prose.\n', ['Backlog Links']);

    expect(plan.missingManagedSections).toEqual(['Backlog Links']);
    expect(plan.droppedManagedSections).toEqual([]);
  });

  it('expects a section only of the items that carry it', () => {
    expect(expectedManagedSections({})).toEqual(['Backlog Links']);
    expect(expectedManagedSections({ executionBase: 'main' })).toEqual(['Backlog Links', 'Base Version']);
    expect(expectedManagedSections({ kind: 'prd' })).toEqual(['Backlog Links', 'Baseline Branch']);
  });

  it('reports a revision that removes the retry marker', () => {
    const marked = `${BODY}\n${idempotencyMarkerComment(idempotencyMarker('prd-42/service'))}\n`;

    const plan = planDescriptionRevision(marked, BODY);

    expect(plan.dropsRetryMarker).toBe(true);
    expect(planDescriptionRevision(BODY, BODY).dropsRetryMarker).toBe(false);
  });

  it('says a body written twice is not a change', () => {
    expect(planDescriptionRevision(BODY, BODY).changed).toBe(false);
  });

  it('lists the managed sections a body carries', () => {
    expect(managedSectionsOf(BODY)).toEqual(['Backlog Links']);
  });
});
