import { describe, expect, it } from 'vitest';
import { buildACLabel, extractAC, extractACFromLabels, parseACLegacy } from './ac.js';

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

  it('parses the canonical three-field acceptance criteria contract', () => {
    const criteria = parseACLegacy([
      '## Acceptance Criteria',
      '- [ ] AuthService.validatePassword unit tests pass -- test -- npm test -- --testPathPattern=auth',
      '- [ ] POST /api/login returns 200 + JWT -- curl -- curl -fsS -X POST http://localhost:3000/api/login | jq -e .token',
      '- [ ] Deprecated endpoint removed, no runtime check -- none --',
    ].join('\n'));
    expect(criteria).toEqual([
      { index: 1, text: 'AuthService.validatePassword unit tests pass', evidenceType: 'test', checkCommand: 'npm test -- --testPathPattern=auth' },
      { index: 2, text: 'POST /api/login returns 200 + JWT', evidenceType: 'curl', checkCommand: 'curl -fsS -X POST http://localhost:3000/api/login | jq -e .token' },
      { index: 3, text: 'Deprecated endpoint removed, no runtime check', evidenceType: 'none', checkCommand: '' },
    ]);
  });

  it('keeps a line that only looks like the three-field contract as plain text', () => {
    const criteria = parseACLegacy('## Acceptance Criteria\n- [ ] 文档说明 -- 不确定 -- 随便');
    expect(criteria).toEqual([{ index: 1, text: '文档说明 -- 不确定 -- 随便', evidenceType: 'none', checkCommand: '' }]);
  });

  it('parses the _verify block form', () => {
    const criteria = parseACLegacy('## Acceptance Criteria\n- [ ] 用户可登录\n  _verify: npm run test:login');
    expect(criteria).toEqual([{ index: 1, text: '用户可登录', evidenceType: 'bash', checkCommand: 'npm run test:login' }]);
  });

  it('keeps the three-field evidence type when a _verify block is also present', () => {
    const criteria = parseACLegacy('## Acceptance Criteria\n- [ ] 用户可登录 -- test -- npm test\n  _verify: npm run test:login');
    expect(criteria).toEqual([{ index: 1, text: '用户可登录', evidenceType: 'test', checkCommand: 'npm test' }]);
  });
});
