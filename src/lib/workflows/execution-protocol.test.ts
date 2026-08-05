import { describe, expect, it } from 'vitest';
import { buildBatchPrompt } from './execution-protocol';

describe('batch execution prompt protocol', () => {
  it('preserves the goal prompt and appends the requested completion marker', () => {
    const prompt = buildBatchPrompt('/goal implement issue #60');

    expect(prompt).toContain('/goal implement issue #60');
    expect(prompt).toContain('<goal_complete>');
    expect(prompt).toContain('"type":"goal_complete"');
    expect(prompt).toContain('</goal_complete>');
  });

  it('requires QA to report its PASS or FAIL outcome in the unified completion payload', () => {
    const prompt = buildBatchPrompt('/goal verify issue #60', 'qa');

    expect(prompt).toContain('<goal_complete>');
    expect(prompt).toContain('"kind":"qa"');
    expect(prompt).toContain('"result":"PASS"');
  });
});
