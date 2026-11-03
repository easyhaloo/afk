import { describe, expect, it } from 'vitest';
import { buildACLabel, extractAC, extractACFromLabels, parseACLegacy, parseThreeFieldAC } from './ac.js';

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

  describe('three-field acceptance criteria', () => {
    it('splits text, evidence type and check command', () => {
      const description = [
        '## Acceptance Criteria',
        '',
        "- [ ] Nacos 不可达时进程启动失败 -- test -- mvn -q -pl aiapi-service -am test -Dtest=WikiRouteRegistryStartUpTest",
        "- [ ] 打印一行就绪日志 -- log -- grep -q '路由映射就绪' logs/aiapi.log",
        "- [ ] 反代路径形态待 U4 拍板 -- manual",
        '- [ ] 不注册 listener -- none -- ! grep -rn addListener src/',
        '',
      ].join('\n');

      expect(parseACLegacy(description)).toEqual([
        {
          index: 1,
          text: 'Nacos 不可达时进程启动失败',
          evidenceType: 'test',
          checkCommand: 'mvn -q -pl aiapi-service -am test -Dtest=WikiRouteRegistryStartUpTest',
        },
        {
          index: 2,
          text: '打印一行就绪日志',
          evidenceType: 'log',
          checkCommand: "grep -q '路由映射就绪' logs/aiapi.log",
        },
        {
          index: 3,
          text: '反代路径形态待 U4 拍板',
          evidenceType: 'manual',
          checkCommand: '',
        },
        {
          index: 4,
          text: '不注册 listener',
          evidenceType: 'none',
          checkCommand: "! grep -rn addListener src/",
        },
      ]);
    });

    it('keeps a separator inside the text when the type is not an evidence type', () => {
      expect(parseThreeFieldAC('a -- b -- c')).toBeNull();
      expect(parseThreeFieldAC('plain text')).toBeNull();
    });

    it('treats the command as everything after the evidence type', () => {
      expect(parseThreeFieldAC('x -- bash -- grep -- foo')).toEqual({
        text: 'x',
        evidenceType: 'bash',
        checkCommand: 'grep -- foo',
      });
    });

    it('leaves a line without a known type as plain text', () => {
      expect(parseACLegacy('## AC\n- [ ] just text\n- [ ] with -- unknown -- tail')).toMatchObject([
        { text: 'just text', evidenceType: 'none', checkCommand: '' },
        { text: 'with -- unknown -- tail', evidenceType: 'none', checkCommand: '' },
      ]);
    });

    it('prefers the three-field form over a _verify line', () => {
      const description = '## AC\n- [ ] text -- test -- pytest t.py\n  _verify: pytest other.py';
      expect(parseACLegacy(description)).toMatchObject([
        { text: 'text', evidenceType: 'test', checkCommand: 'pytest t.py' },
      ]);
    });
  });
});
