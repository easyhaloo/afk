import { describe, expect, it } from 'vitest';
import {
  canonicalizeBacklogReference,
  decodeBacklogMetadata,
  decodeBacklogRelations,
  encodeBacklogRelations,
  isBacklogRelationLabel,
  planRelationLabelDelta,
  planModeLabelDelta,
  planRoleLabelDelta,
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

describe('backlog relation label delta', () => {
  it('replaces the parent edge and leaves every other label alone', () => {
    const labels = ['stage::ready-for-issues', 'mode::afk', 'parent::github:org/repo#1', 'depends-on::github:org/repo#9'];
    expect(planRelationLabelDelta(labels, { parent: '2' }, scope)).toEqual({
      add: ['parent::github:org/repo#2'],
      remove: ['parent::github:org/repo#1'],
    });
  });

  it('drops the parent edge when it is cleared', () => {
    expect(planRelationLabelDelta(['parent::github:org/repo#1', 'kind::prd'], { clearParent: true }, scope)).toEqual({
      add: [],
      remove: ['parent::github:org/repo#1'],
    });
  });

  it('withdraws the execution baseline edge when it is cleared', () => {
    expect(planRelationLabelDelta(['base::prd-24'], { clearBase: true }, scope)).toEqual({
      add: [],
      remove: ['base::prd-24'],
    });
  });

  it('keeps the edges the edit does not mention', () => {
    const labels = ['parent::github:org/repo#1', 'base::github:org/repo#3', 'depends-on::github:org/repo#9'];
    expect(planRelationLabelDelta(labels, { addDependsOn: ['4'] }, scope)).toEqual({
      add: ['depends-on::github:org/repo#4'],
      remove: [],
    });
  });

  it('withdraws a dependency by reference and keeps the others', () => {
    const labels = ['depends-on::github:org/repo#9', 'depends-on::github:org/repo#4'];
    expect(planRelationLabelDelta(labels, { removeDependsOn: ['9'] }, scope)).toEqual({
      add: [],
      remove: ['depends-on::github:org/repo#9'],
    });
  });

  it('rewrites the legacy dependency spelling in the canonical form', () => {
    expect(planRelationLabelDelta(['depends_on::github:org/repo#9'], { addDependsOn: ['9'] }, scope)).toEqual({
      add: ['depends-on::github:org/repo#9'],
      remove: ['depends_on::github:org/repo#9'],
    });
  });

  it('changes nothing when the edge is already the one that was asked for', () => {
    expect(planRelationLabelDelta(['parent::github:org/repo#2'], { parent: '2' }, scope)).toEqual({ add: [], remove: [] });
    expect(planRelationLabelDelta(['depends-on::github:org/repo#4'], { addDependsOn: ['4'] }, scope)).toEqual({ add: [], remove: [] });
  });

  it('refuses an edge that points at the item itself', () => {
    expect(() => planRelationLabelDelta([], { parent: '7' }, scope, { selfId: 'github:org/repo#7' })).toThrow(/itself/);
    expect(() => planRelationLabelDelta([], { addDependsOn: ['7'] }, scope, { selfId: 'github:org/repo#7' })).toThrow(/itself/);
  });

  it('refuses an edit that sets and clears the same edge', () => {
    expect(() => planRelationLabelDelta([], { parent: '7', clearParent: true }, scope)).toThrow(/at once/);
    expect(() => planRelationLabelDelta([], { base: '7', clearBase: true }, scope)).toThrow(/at once/);
  });

  it('leaves a label it cannot parse alone until the edge is named', () => {
    expect(planRelationLabelDelta(['parent::not-a-reference'], { addDependsOn: ['4'] }, scope)).toEqual({
      add: ['depends-on::github:org/repo#4'],
      remove: [],
    });
    expect(planRelationLabelDelta(['parent::not-a-reference'], { clearParent: true }, scope)).toEqual({
      add: [],
      remove: ['parent::not-a-reference'],
    });
  });
});

describe('backlog role label delta', () => {
  it('turns a work item into an anchor and drops its lifecycle state', () => {
    expect(planRoleLabelDelta(['stage::ready-for-issues', 'mode::afk'], 'prd')).toEqual({
      add: ['kind::prd', 'mode::hitl'],
      remove: ['stage::ready-for-issues', 'mode::afk'],
    });
  });

  it('keeps the role an item already carries', () => {
    // A label in both lists would simply be removed by the provider: the
    // removals are applied first, and the addition is dropped for a label
    // that is being removed.
    expect(planRoleLabelDelta(['kind::prd', 'mode::hitl'], 'prd')).toEqual({ add: [], remove: [] });
  });

  it('removes the legacy stage labels an anchor must not carry', () => {
    expect(planRoleLabelDelta(['kind::prd', 'stage::approved', 'stage::research'], 'prd')).toEqual({
      add: ['mode::hitl'],
      remove: ['stage::approved', 'stage::research'],
    });
  });

  it('leaves the business tags and the relationships alone', () => {
    expect(planRoleLabelDelta(['billing', 'parent::github:org/repo#1', 'depends-on::github:org/repo#9'], 'prd')).toEqual({
      add: ['kind::prd', 'mode::hitl'],
      remove: [],
    });
  });
});

describe('backlog execution mode label delta', () => {
  it('hands an item to AFK and takes it away from the human', () => {
    expect(planModeLabelDelta(['stage::ready-for-issues', 'mode::hitl'], 'afk')).toEqual({
      add: ['mode::afk'],
      remove: ['mode::hitl'],
    });
  });

  it('keeps the mode an item already carries', () => {
    expect(planModeLabelDelta(['stage::ready-for-issues', 'mode::afk'], 'afk')).toEqual({
      add: [],
      remove: [],
    });
  });

  it('leaves the stage, the role, the business tags and the relationships alone', () => {
    expect(planModeLabelDelta(
      ['stage::ready-for-issues', 'kind::prd', 'billing', 'parent::github:org/repo#1'],
      'hitl',
    )).toEqual({
      add: ['mode::hitl'],
      remove: [],
    });
  });
});
