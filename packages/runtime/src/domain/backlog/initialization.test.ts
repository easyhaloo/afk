import { describe, expect, it } from 'vitest';
import {
  BACKLOG_METADATA,
  backlogMetadataLabelSpecs,
  FIXED_BACKLOG_TAGS,
} from './initialization.js';
import { isInternalBacklogLabel, isWorkflowMetadataLabel, validateBusinessTag } from './tags.js';

/**
 * The stage and mode labels project the canonical execution state, so the
 * adapter rewrites them on every transition.  The fixed labels classify an
 * item instead: they must survive a transition and must still be settable as
 * ordinary business tags.
 */
describe('backlog metadata label specs', () => {
  it('provisions the fixed prd label with a colour and a description', () => {
    const specs = backlogMetadataLabelSpecs();
    const prd = specs.find(spec => spec.name === FIXED_BACKLOG_TAGS.prd.name);

    expect(prd).toBeDefined();
    expect(prd).toMatchObject({
      color: FIXED_BACKLOG_TAGS.prd.color,
      description: FIXED_BACKLOG_TAGS.prd.description,
    });
    expect(prd?.color).toMatch(/^[0-9a-f]{6}$/i);
  });

  it('keeps every stage and mode label in the provisioned set', () => {
    const names = backlogMetadataLabelSpecs().map(spec => spec.name);

    expect(names).toEqual(expect.arrayContaining([
      ...Object.values(BACKLOG_METADATA.stateLabels),
      ...Object.values(BACKLOG_METADATA.executionModeLabels),
    ]));
  });

  it('gives every provisioned label a colour and a description', () => {
    for (const spec of backlogMetadataLabelSpecs()) {
      expect(spec.color, spec.name).toMatch(/^[0-9a-f]{6}$/i);
      expect(spec.description, spec.name).not.toBe('');
    }
  });

  it('treats a fixed label as business metadata that survives a state transition', () => {
    expect(isInternalBacklogLabel(FIXED_BACKLOG_TAGS.prd.name)).toBe(false);
    expect(isWorkflowMetadataLabel(FIXED_BACKLOG_TAGS.prd.name)).toBe(false);
    expect(validateBusinessTag(FIXED_BACKLOG_TAGS.prd.name)).toBe(FIXED_BACKLOG_TAGS.prd.name);
  });

  it('keeps the prd label outside the reserved stage namespace', () => {
    // `stage::` is rewritten on every transition, so a PRD marker placed
    // there would be erased the first time the item moves.
    expect(FIXED_BACKLOG_TAGS.prd.name.startsWith('stage::')).toBe(false);
    expect(isWorkflowMetadataLabel('stage::prd')).toBe(true);
  });
});
