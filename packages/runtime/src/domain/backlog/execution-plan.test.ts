import { describe, expect, it } from 'vitest';
import { createExecutionPlan, parseExecutionPlan } from './execution-plan.js';
import { applyExecutionBaseBranch } from './execution-base.js';

describe('execution plans', () => {
  it('reads independent base, publication target and migration source as immutable facts', () => {
    const plan = parseExecutionPlan('## Base Version\n- Base Ref: release\n- Target Ref: production\n- Source Ref: profession\n## Notes\n- Base Ref: ignored');
    expect(plan).toEqual({ baseRef: 'release', targetRef: 'production', sourceRef: 'profession' });
    expect(Object.isFrozen(plan)).toBe(true);
    expect(parseExecutionPlan('## Base Version\n- Base Ref: release')).toEqual({ baseRef: 'release', targetRef: 'release' });
    expect(parseExecutionPlan('Branch release is mentioned only in prose')).toBeUndefined();
  });

  it.each([
    '## Base Version\n- Target Ref: production',
    '## Base Version\n- Base Ref: release\n- Base Ref: other',
    '## Base Version\n- Base Ref: release\n- Source Ref: --upload-pack=evil',
    '## Base Version\n- Base Ref: a/../b',
    '## Base Version\n- Base Ref:',
  ])('rejects incomplete, conflicting and unsafe declarations: %s', description => {
    expect(() => parseExecutionPlan(description)).toThrow();
  });

  it('retains target and source when updating the execution base and emits only one section', () => {
    const updated = applyExecutionBaseBranch('## Base Version\n- Base Ref: old\n- Target Ref: production\n- Source Ref: profession\n## Context\ntext', 'release');
    expect(updated.match(/## Base Version/g)).toHaveLength(1);
    expect(parseExecutionPlan(updated)).toEqual(createExecutionPlan({ baseRef: 'release', targetRef: 'production', sourceRef: 'profession' }));
    expect(updated).toContain('## Context\ntext');
  });
});
