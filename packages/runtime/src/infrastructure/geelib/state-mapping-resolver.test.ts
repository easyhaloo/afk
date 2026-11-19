import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_GELIB_STATE_MAPPINGS_PATH,
  GeelibStateMappingResolver,
  loadGeelibStateMappings,
} from './state-mapping-resolver.js';

/** The 需求 workflow of the reference project: names the static map does not know. */
const DEMAND_TYPE = { subId: 6856, typeId: 20651, typeName: '需求' };

describe('GeelibStateMappingResolver', () => {
  it('resolves an AFK state onto the configured native name of a project+type', () => {
    const resolver = new GeelibStateMappingResolver([{
      project: 6856,
      type: '需求',
      states: { in_progress: '进行中', done: '已上线' },
    }]);

    expect(resolver.nativeStateFor(DEMAND_TYPE, 'in_progress')).toBe('进行中');
    expect(resolver.nativeStateFor(DEMAND_TYPE, 'done')).toBe('已上线');
  });

  it('reverse-maps a configured native name onto its AFK state for the read path', () => {
    const resolver = new GeelibStateMappingResolver([{
      project: 6856,
      type: '需求',
      states: { in_progress: '进行中', done: '已上线' },
    }]);

    expect(resolver.afkStateFor(DEMAND_TYPE, '进行中')).toBe('in_progress');
    expect(resolver.afkStateFor(DEMAND_TYPE, '已上线')).toBe('done');
  });

  it('matches a numeric type key by type id and a name key by type name', () => {
    const resolver = new GeelibStateMappingResolver([
      { project: 6856, type: '20651', states: { ready: '待处理' } },
      { project: '6856', type: '任务', states: { ready: '待启动' } },
    ]);

    expect(resolver.nativeStateFor(DEMAND_TYPE, 'ready')).toBe('待处理');
    expect(resolver.nativeStateFor({ subId: 6856, typeId: 20700, typeName: '任务' }, 'ready')).toBe('待启动');
  });

  it('returns undefined for an unconfigured project or type', () => {
    const resolver = new GeelibStateMappingResolver([{
      project: 6856,
      type: '需求',
      states: { in_progress: '进行中' },
    }]);

    expect(resolver.nativeStateFor({ subId: 4065, typeId: 20651, typeName: '需求' }, 'in_progress')).toBeUndefined();
    expect(resolver.nativeStateFor({ subId: 6856, typeId: 20655, typeName: '缺陷' }, 'in_progress')).toBeUndefined();
    expect(resolver.afkStateFor(DEMAND_TYPE, '规划中')).toBeUndefined();
  });

  it('prefers the type name over the type id when both could match', () => {
    // Two entries collide on the same project: the name key wins because the
    // name is the stable identifier the configuration documents.
    const resolver = new GeelibStateMappingResolver([
      { project: 6856, type: '20651', states: { ready: '按类型编号' } },
      { project: 6856, type: '需求', states: { ready: '按类型名' } },
    ]);

    expect(resolver.nativeStateFor(DEMAND_TYPE, 'ready')).toBe('按类型名');
  });

  it('resolves without a type name through the type id', () => {
    const resolver = new GeelibStateMappingResolver([{
      project: 6856,
      type: '需求',
      states: { ready: '待处理' },
    }]);

    // The platform's matter payload may carry no type name; a name-keyed
    // entry then cannot match and resolution falls through (fail-safe).
    expect(resolver.nativeStateFor({ subId: 6856, typeId: 20651, typeName: undefined }, 'ready')).toBeUndefined();
  });

  it('rejects an unknown AFK state key with the valid names', () => {
    expect(() => new GeelibStateMappingResolver([{
      project: 6856,
      type: '需求',
      states: { inprogress: '进行中' },
    }])).toThrow(/inprogress.*not an AFK state.*ready.*blocked/s);
  });

  it('rejects empty or non-string native names', () => {
    expect(() => new GeelibStateMappingResolver([{
      project: 6856, type: '需求', states: { ready: '' },
    }])).toThrow(/project 6856.*type 需求.*non-empty/s);
    expect(() => new GeelibStateMappingResolver([{
      project: 6856, type: '需求', states: { ready: 42 as unknown as string },
    }])).toThrow(/project 6856.*type 需求.*non-empty/s);
  });

  it('rejects an entry without project, type or states', () => {
    expect(() => new GeelibStateMappingResolver([{ type: '需求', states: { ready: '待处理' } } as never]))
      .toThrow(/entry #1.*project/s);
    expect(() => new GeelibStateMappingResolver([{ project: 6856, states: { ready: '待处理' } } as never]))
      .toThrow(/entry #1.*type/s);
    expect(() => new GeelibStateMappingResolver([{ project: 6856, type: '需求' } as never]))
      .toThrow(/entry #1.*states/s);
    expect(() => new GeelibStateMappingResolver([{
      project: 6856, type: '需求', states: {},
    }])).toThrow(/entry #1.*states/s);
  });

  it('rejects two entries for the same project+type instead of silently merging', () => {
    expect(() => new GeelibStateMappingResolver([
      { project: 6856, type: '需求', states: { ready: '待处理' } },
      { project: '6856', type: '需求', states: { done: '已上线' } },
    ])).toThrow(/duplicate.*6856.*需求/s);
  });

  it('accepts an empty configuration as the no-mapping default', () => {
    const resolver = new GeelibStateMappingResolver([]);
    expect(resolver.isEmpty).toBe(true);
    expect(resolver.nativeStateFor(DEMAND_TYPE, 'ready')).toBeUndefined();
  });
});

describe('loadGeelibStateMappings', () => {
  const dir = mkdtempSync(join(tmpdir(), 'afk-geelib-mappings-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('defaults to the standard location under ~/.afk', () => {
    expect(DEFAULT_GELIB_STATE_MAPPINGS_PATH).toContain('.afk');
    expect(DEFAULT_GELIB_STATE_MAPPINGS_PATH).toMatch(/geelib-state-mappings\.yml$/);
  });

  it('parses the documented YAML shape into a resolver', () => {
    const path = join(dir, 'valid.yml');
    writeFileSync(path, [
      'mappings:',
      '  - project: 6856',
      '    type: 需求',
      '    states:',
      '      ready: 待处理',
      '      in_progress: 进行中',
      '      done: 已上线',
    ].join('\n'));

    const resolver = loadGeelibStateMappings(path);
    expect(resolver.nativeStateFor(DEMAND_TYPE, 'in_progress')).toBe('进行中');
    expect(resolver.afkStateFor(DEMAND_TYPE, '已上线')).toBe('done');
  });

  it('treats a missing file as no configuration', () => {
    const resolver = loadGeelibStateMappings(join(dir, 'absent.yml'));
    expect(resolver.isEmpty).toBe(true);
  });

  it('reports invalid YAML with the file path', () => {
    const path = join(dir, 'broken.yml');
    writeFileSync(path, 'mappings: [ { project: 6856,');

    expect(() => loadGeelibStateMappings(path)).toThrow(new RegExp(path.replace(/\./g, '\\.')));
  });

  it('reports a malformed document and invalid entries with the file path', () => {
    const scalar = join(dir, 'scalar.yml');
    writeFileSync(scalar, 'just a string');
    expect(() => loadGeelibStateMappings(scalar)).toThrow(/must contain a `mappings` list/);

    const badEntry = join(dir, 'bad-entry.yml');
    writeFileSync(badEntry, [
      'mappings:',
      '  - project: 6856',
      '    type: 需求',
      '    states:',
      '      inprogress: 进行中',
    ].join('\n'));
    expect(() => loadGeelibStateMappings(badEntry)).toThrow(/inprogress.*not an AFK state/s);
  });
});
