import { describe, expect, it } from 'vitest';
import { buildACLabel, extractAC, extractACFromLabels, parseACLegacy } from './ac';

describe('tracker acceptance criteria', () => {
  it('prioritizes ordered label criteria over legacy description criteria', () => {
    const criteria = extractAC({
      labels: [buildACLabel(2, 'second'), buildACLabel(1, 'first')],
      description: '## AC\n- [ ] old -- none --',
    });
    expect(criteria.source).toBe('labels');
    expect(criteria.items.map(item => item.text)).toEqual(['first', 'second']);
    expect(extractACFromLabels(['unrelated'])).toEqual([]);
  });

  it('retains the legacy markdown fallback', () => {
    expect(parseACLegacy('## AC\n- [ ] old')).toMatchObject([{ text: 'old' }]);
    expect(extractAC({ labels: [], description: '## AC\n- [ ] old' }).source).toBe('legacy');
  });
});
