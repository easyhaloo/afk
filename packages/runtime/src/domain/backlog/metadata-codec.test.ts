import { describe, expect, it } from 'vitest';
import {
  canonicalizeBacklogReference,
  decodeBacklogMetadata,
  decodeBacklogRelations,
  encodeBacklogRelations,
  isBacklogRelationLabel,
} from './metadata-codec.js';

const scope = { platform: 'github' as const, projectKey: 'org/repo' };

describe('backlog metadata codec', () => {
  it('resolves a bare issue number against the owning project', () => {
    expect(canonicalizeBacklogReference('7', scope)).toBe('github:org/repo#7');
    expect(canonicalizeBacklogReference('007', scope)).toBe('github:org/repo#7');
  });

  it('keeps a qualified reference in the project it names', () => {
    expect(canonicalizeBacklogReference('github:org/other#5', scope)).toBe('github:org/other#5');
    expect(canonicalizeBacklogReference('gitlab:group/repo#5', scope)).toBe('gitlab:group/repo#5');
  });

  it.each(['', '0', '-1', '1e2', '1.5', '9007199254740992', 'github:org/repo#01', 'github:org/repo#'])(
    'rejects an invalid reference: %s', value => {
      expect(() => canonicalizeBacklogReference(value, scope)).toThrow();
    });

  it('reads the lifecycle, the relationships and the business tags of one issue', () => {
    const metadata = decodeBacklogMetadata([
      'stage::ready-for-issues', 'mode::afk',
      'parent::10', 'base::8', 'depends-on::9', 'depends_on::11',
      'team::api',
    ], scope);

    expect(metadata).toMatchObject({
      state: 'ready',
      executionMode: 'afk',
      relations: {
        parentId: 'github:org/repo#10',
        baseBacklogId: 'github:org/repo#8',
        dependsOn: ['github:org/repo#9', 'github:org/repo#11'],
      },
      tags: ['team::api'],
    });
  });

  it('accepts the legacy PRD base form when the reader allows it', () => {
    expect(decodeBacklogRelations(['base::prd-10'], scope, { allowLegacyBase: true }))
      .toMatchObject({ legacyBaseRef: 'prd-10' });
    expect(() => decodeBacklogRelations(['base::prd-10'], scope, { strict: true }))
      .toThrow('legacy PRD base form');
  });

  it.each([
    [['base::1', 'base::2'], 'duplicate parent, base, or dependency'],
    [['parent::1', 'parent::2'], 'duplicate parent, base, or dependency'],
    [['depends-on::1', 'depends_on::1'], 'duplicate parent, base, or dependency'],
    [['parent::07'], 'canonical backlog ID'],
    [['parent:: 7'], 'canonical backlog ID'],
    [['base::0'], 'canonical backlog ID'],
    [['base::abc'], 'canonical backlog ID'],
    [['depends-on::'], 'canonical backlog ID'],
  ])('rejects malformed relationship metadata: %j', (labels, message) => {
    expect(() => decodeBacklogRelations(labels, scope, { strict: true })).toThrow(message);
  });

  it('rejects a relationship that points at the item itself', () => {
    expect(() => decodeBacklogRelations(['parent::42'], scope, { strict: true, selfId: 'github:org/repo#42' }))
      .toThrow('points at the item itself');
    expect(decodeBacklogRelations(['parent::42'], scope, { selfId: 'github:org/repo#42' }).parentId).toBeUndefined();
  });

  it('drops a malformed edge instead of hiding the whole issue in a project scan', () => {
    const relations = decodeBacklogRelations(['parent::abc', 'depends-on::9'], scope);
    expect(relations.parentId).toBeUndefined();
    expect(relations.dependsOn).toEqual(['github:org/repo#9']);
  });

  it('round-trips the relationships it wrote', () => {
    const relations = {
      parentId: 'github:org/repo#10' as const,
      baseBacklogId: 'github:org/other#8' as const,
      dependsOn: ['github:org/repo#9' as const],
    };
    const labels = encodeBacklogRelations(relations);
    expect(labels).toEqual(['parent::github:org/repo#10', 'base::github:org/other#8', 'depends-on::github:org/repo#9']);
    expect(decodeBacklogRelations(labels, scope)).toEqual(relations);
  });

  it('recognizes every label that carries a relationship edge', () => {
    expect(isBacklogRelationLabel('parent::1')).toBe(true);
    expect(isBacklogRelationLabel('base::1')).toBe(true);
    expect(isBacklogRelationLabel('depends-on::1')).toBe(true);
    expect(isBacklogRelationLabel('depends_on::1')).toBe(true);
    expect(isBacklogRelationLabel('team::api')).toBe(false);
    expect(isBacklogRelationLabel('stage::prd')).toBe(false);
  });
});
