import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readExperienceKnowledgeConfiguration } from './experience-configuration.js';

const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });

function temporaryHome(): string {
  const home = mkdtempSync(join(realpathSync(tmpdir()), 'experience-configuration-'));
  homes.push(home);
  mkdirSync(join(home, '.afk'));
  return home;
}

function configuration(home: string) {
  return { enabled: false, knowledge: { wikiScript: join(home, 'wiki.sh'), grants: [join(home, 'grant.json')] },
    validation: { configurationFile: join(home, 'validation.json') } };
}

function writeEntries(home: string, plugins: unknown[]): void {
  writeFileSync(join(home, '.afk', 'plugins.yml'), JSON.stringify({ plugins }));
}

function entry(home: string) {
  return { id: 'learning.distiller', builtin: true, config: configuration(home) };
}

describe('experience knowledge configuration', () => {
  it('resolves existing assets while automatic learning is disabled', () => {
    const home = temporaryHome();
    writeEntries(home, [entry(home)]);
    expect(readExperienceKnowledgeConfiguration(home)).toEqual({
      homeDir: home,
      file: join(home, '.afk', 'learning', 'candidates.sqlite'),
      recoveryDirectory: join(home, '.afk', 'learning', 'publications'),
      config: configuration(home).knowledge,
      validationConfigurationFile: configuration(home).validation.configurationFile,
    });
  });

  it('fails closed for absent, disabled, nonbuiltin or ambiguous entries', () => {
    const home = temporaryHome();
    expect(readExperienceKnowledgeConfiguration(home)).toBeUndefined();
    const valid = entry(home);
    for (const plugins of [[], [{ ...valid, id: 'context.experience' }], [{ ...valid, enabled: false }],
      [{ ...valid, builtin: false }], [{ id: valid.id, config: valid.config }], [valid, valid],
      [valid, { ...valid, enabled: false, builtin: false }]]) {
      writeEntries(home, plugins);
      expect(readExperienceKnowledgeConfiguration(home)).toBeUndefined();
    }
  });

  it('preserves the configured source read grant for existing publications', () => {
    const home = temporaryHome();
    const valid = entry(home);
    const knowledge = { ...valid.config.knowledge, sourceReadGrantFile: join(home, 'read.json') };
    writeEntries(home, [{ ...valid, config: { ...valid.config, knowledge } }]);
    expect(readExperienceKnowledgeConfiguration(home)?.config).toEqual(knowledge);
  });

  it('fails closed for missing or malformed knowledge and validation settings', () => {
    const home = temporaryHome();
    const valid = configuration(home);
    const invalid: unknown[] = [undefined, {}, { ...valid, enabled: 'false' },
      { ...valid, knowledge: undefined }, { ...valid, validation: undefined },
      { ...valid, knowledge: { ...valid.knowledge, wikiScript: 'relative/wiki.sh' } },
      { ...valid, knowledge: { ...valid.knowledge, grants: [] } },
      { ...valid, knowledge: { ...valid.knowledge, sourceReadGrantFile: 'relative/read.json' } },
      { ...valid, knowledge: { ...valid.knowledge, grants: [valid.knowledge.grants[0], valid.knowledge.grants[0]] } },
      { ...valid, knowledge: { ...valid.knowledge, grants: ['relative/grant.json'] } },
      { ...valid, knowledge: { ...valid.knowledge, unexpected: true } },
      { ...valid, validation: {} }, { ...valid, validation: { configurationFile: 'relative/validation.json' } },
      { ...valid, validation: { configurationFile: `${home}/../validation.json` } },
      { ...valid, validation: { configurationFile: `${home}/validation.json\n` } },
      { ...valid, validation: { ...valid.validation, unexpected: true } }];
    for (const config of invalid) {
      writeEntries(home, [{ ...entry(home), config }]);
      expect(readExperienceKnowledgeConfiguration(home)).toBeUndefined();
    }
  });

  it('contains YAML, configuration shape and disk read failures', () => {
    const home = temporaryHome();
    const file = join(home, '.afk', 'plugins.yml');
    for (const content of ['plugins: [', JSON.stringify({ plugins: {} }), JSON.stringify({ plugins: [{ ...entry(home), enabled: 'yes' }] })]) {
      writeFileSync(file, content);
      expect(readExperienceKnowledgeConfiguration(home)).toBeUndefined();
    }
    rmSync(file);
    mkdirSync(file);
    expect(readExperienceKnowledgeConfiguration(home)).toBeUndefined();
  });

  it('rereads configuration changes on every call', () => {
    const home = temporaryHome();
    const valid = entry(home);
    writeEntries(home, [valid]);
    expect(readExperienceKnowledgeConfiguration(home)?.config.grants).toEqual(valid.config.knowledge.grants);
    const grants = [join(home, 'replacement-grant.json')];
    writeEntries(home, [{ ...valid, config: { ...valid.config, knowledge: { ...valid.config.knowledge, grants } } }]);
    expect(readExperienceKnowledgeConfiguration(home)?.config.grants).toEqual(grants);
    writeEntries(home, [{ ...valid, enabled: false }]);
    expect(readExperienceKnowledgeConfiguration(home)).toBeUndefined();
  });

  it('isolates explicit homes and rejects absent or noncanonical homes', () => {
    const first = temporaryHome();
    const second = temporaryHome();
    writeEntries(first, [entry(first)]);
    expect(readExperienceKnowledgeConfiguration(second)).toBeUndefined();
    writeEntries(second, [entry(second)]);
    expect(readExperienceKnowledgeConfiguration(first)?.config).toEqual(configuration(first).knowledge);
    expect(readExperienceKnowledgeConfiguration(second)?.config).toEqual(configuration(second).knowledge);
    expect(readExperienceKnowledgeConfiguration(first)?.file).not.toEqual(readExperienceKnowledgeConfiguration(second)?.file);
    for (const home of ['', 'relative', `${first}/..`, undefined, null]) {
      expect(readExperienceKnowledgeConfiguration(home as string)).toBeUndefined();
    }
  });
});
