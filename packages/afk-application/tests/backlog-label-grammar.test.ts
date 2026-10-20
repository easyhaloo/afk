import { describe, expect, it } from 'vitest';
import {
  projectBacklogLabels,
  renderBacklogId,
  resolveBacklogFilterId,
  type BacklogIdentityPolicy,
  type BacklogIssueState,
  type BacklogLabelProjection,
  type ScopedBacklogIdentityPolicy,
} from '../src/index.js';
import type { WorkItemId } from '../src/index.js';

/**
 * The grammar table.
 *
 * Every row states one fact about the label grammar: which state a state
 * label carries, which mode a mode label carries, which relation a
 * relation label names, and what happens to a value that names no
 * identity at all.
 */
interface GrammarCase {
  readonly name: string;
  readonly labels: readonly string[];
  readonly issue?: BacklogIssueState;
  readonly policy?: ScopedBacklogIdentityPolicy;
  readonly expected: BacklogLabelProjection;
}

const WORK_ITEM: ScopedBacklogIdentityPolicy = {
  kind: 'work-item',
  scope: { platform: 'github', projectKey: 'acme/api' },
};

const PROVIDER_LOCAL: ScopedBacklogIdentityPolicy = {
  kind: 'provider-local',
  scope: { platform: 'github', projectKey: 'org/repo' },
};

function projection(overrides: Partial<BacklogLabelProjection>): BacklogLabelProjection {
  return {
    state: 'blocked',
    executionMode: 'hitl',
    managed: false,
    executionEligible: false,
    dependsOn: [],
    ...overrides,
  };
}

const GRAMMAR_CASES: GrammarCase[] = [
  {
    name: 'an issue without labels is blocked and not managed',
    labels: [],
    expected: projection({}),
  },
  {
    name: 'a business label alone is not AFK metadata',
    labels: ['team::api'],
    expected: projection({}),
  },
  {
    name: 'a state label alone is not managed',
    labels: ['stage::ready-for-issues'],
    expected: projection({ state: 'ready' }),
  },
  {
    name: 'a mode label alone is not managed',
    labels: ['mode::afk'],
    expected: projection({ executionMode: 'afk' }),
  },
  {
    name: 'a state label and a mode label make an issue managed',
    labels: ['stage::ready-for-issues', 'mode::afk'],
    expected: projection({ state: 'ready', executionMode: 'afk', managed: true, executionEligible: true }),
  },
  {
    name: 'a ready hitl issue stays eligible for a foreground run',
    labels: ['stage::ready-for-issues', 'mode::hitl'],
    expected: projection({ state: 'ready', executionMode: 'hitl', managed: true, executionEligible: true }),
  },
  {
    name: 'stage::ready-for-issues carries the ready state',
    labels: ['stage::ready-for-issues', 'mode::afk'],
    expected: projection({ state: 'ready', executionMode: 'afk', managed: true, executionEligible: true }),
  },
  {
    name: 'stage::rework carries the rework state',
    labels: ['stage::rework', 'mode::afk'],
    expected: projection({ state: 'rework', executionMode: 'afk', managed: true, executionEligible: true }),
  },
  {
    name: 'stage::afk-in-progress carries the in_progress state',
    labels: ['stage::afk-in-progress', 'mode::afk'],
    expected: projection({ state: 'in_progress', executionMode: 'afk', managed: true }),
  },
  {
    name: 'stage::qa carries the verification state',
    labels: ['stage::qa', 'mode::afk'],
    expected: projection({ state: 'verification', executionMode: 'afk', managed: true }),
  },
  {
    name: 'stage::merge-ready carries the merge_ready state',
    labels: ['stage::merge-ready', 'mode::afk'],
    expected: projection({ state: 'merge_ready', executionMode: 'afk', managed: true }),
  },
  {
    name: 'stage::done carries the done state',
    labels: ['stage::done', 'mode::afk'],
    expected: projection({ state: 'done', executionMode: 'afk', managed: true }),
  },
  {
    name: 'stage::blocked carries the blocked state',
    labels: ['stage::blocked', 'mode::afk'],
    expected: projection({ state: 'blocked', executionMode: 'afk', managed: true }),
  },
  {
    name: 'mode::afk carries the afk mode',
    labels: ['stage::ready-for-issues', 'mode::afk'],
    expected: projection({ state: 'ready', executionMode: 'afk', managed: true, executionEligible: true }),
  },
  {
    name: 'mode::hitl carries the hitl mode',
    labels: ['stage::ready-for-issues', 'mode::hitl'],
    expected: projection({ state: 'ready', executionMode: 'hitl', managed: true, executionEligible: true }),
  },
  {
    name: 'the vocabulary order decides which state label wins',
    labels: ['stage::rework', 'stage::ready-for-issues', 'mode::afk'],
    expected: projection({ state: 'ready', executionMode: 'afk', managed: true, executionEligible: true }),
  },
  {
    name: 'the vocabulary order decides which mode label wins',
    labels: ['stage::ready-for-issues', 'mode::hitl', 'mode::afk'],
    expected: projection({ state: 'ready', executionMode: 'afk', managed: true, executionEligible: true }),
  },
  {
    name: 'a closed issue is done whatever its labels say',
    labels: ['stage::ready-for-issues', 'mode::afk'],
    issue: 'closed',
    expected: projection({ state: 'done', executionMode: 'afk', managed: true }),
  },
  {
    name: 'a merged issue is done whatever its labels say',
    labels: ['stage::ready-for-issues', 'mode::afk'],
    issue: 'merged',
    expected: projection({ state: 'done', executionMode: 'afk', managed: true }),
  },
  {
    name: 'a parent label names the issue project',
    labels: ['parent::5'],
    expected: projection({ parentId: 'github:acme/api#5' as WorkItemId }),
  },
  {
    name: 'a parent label may name another project',
    labels: ['parent::gitlab:host/group/proj#7'],
    expected: projection({ parentId: 'gitlab:host/group/proj#7' as WorkItemId }),
  },
  {
    name: 'a parent label of the provider own scope names that project',
    labels: ['parent::5'],
    policy: PROVIDER_LOCAL,
    expected: projection({ parentId: 'github:org/repo#5' as WorkItemId }),
  },
  {
    name: 'a base label names the execution base',
    labels: ['base::6'],
    expected: projection({ baseBacklogId: 'github:acme/api#6' as WorkItemId }),
  },
  {
    name: 'a depends-on label names a dependency',
    labels: ['depends-on::9'],
    expected: projection({ dependsOn: ['github:acme/api#9'] }),
  },
  {
    name: 'depends_on names the same relation as depends-on',
    labels: ['depends_on::9'],
    expected: projection({ dependsOn: ['github:acme/api#9'] }),
  },
  {
    name: 'the same dependency named twice is one dependency',
    labels: ['depends-on::9', 'depends_on::9'],
    expected: projection({ dependsOn: ['github:acme/api#9'] }),
  },
  {
    name: 'a dependency of another project keeps its canonical identity',
    labels: ['depends-on::gitlab:host/group/proj#7'],
    expected: projection({ dependsOn: ['gitlab:host/group/proj#7'] }),
  },
  {
    name: 'a malformed parent value is dropped',
    labels: ['parent::abc'],
    expected: projection({}),
  },
  {
    name: 'a malformed base value is dropped',
    labels: ['base::abc'],
    expected: projection({}),
  },
  {
    name: 'a malformed dependency value is dropped',
    labels: ['depends-on::abc'],
    expected: projection({}),
  },
  {
    name: 'an empty relation value is dropped',
    labels: ['parent::'],
    expected: projection({}),
  },
  {
    name: 'a zero issue number is dropped',
    labels: ['parent::0'],
    expected: projection({}),
  },
  {
    name: 'a negative issue number is dropped',
    labels: ['parent::-1'],
    expected: projection({}),
  },
  {
    name: 'a fractional issue number is dropped',
    labels: ['parent::1.5'],
    expected: projection({}),
  },
  {
    name: 'a padded issue number is dropped',
    labels: ['parent::07'],
    expected: projection({}),
  },
  {
    name: 'an unsafe issue number is dropped',
    labels: ['parent::9007199254740992'],
    expected: projection({}),
  },
  {
    name: 'a relation value with an extra segment is dropped',
    labels: ['parent::7::8'],
    expected: projection({}),
  },
  {
    name: 'a non canonical work item id is dropped',
    labels: ['parent::github:acme/api#007'],
    expected: projection({}),
  },
  {
    name: 'a relation value of an unknown platform is dropped',
    labels: ['parent::bitbucket:acme/api#5'],
    expected: projection({}),
  },
];

describe('backlog label grammar', () => {
  it.each(GRAMMAR_CASES)('$name', ({ labels, issue = 'opened', policy = WORK_ITEM, expected }) => {
    expect(projectBacklogLabels(labels, issue, policy)).toEqual(expected);
  });
});

describe('backlog identity policy', () => {
  const MULTI_PROJECT: BacklogIdentityPolicy = { kind: 'work-item' };

  it('reads a canonical work item id as one identity in every policy', () => {
    expect(resolveBacklogFilterId('github:acme/api#42', MULTI_PROJECT)).toBe('github:acme/api#42');
    expect(resolveBacklogFilterId('github:acme/api#42', PROVIDER_LOCAL)).toBe('github:acme/api#42');
  });

  it('reads an unqualified issue number as the one identity of a single project provider', () => {
    expect(resolveBacklogFilterId('42', PROVIDER_LOCAL)).toBe('github:org/repo#42');
  });

  it('rejects an unqualified issue number in a provider that reaches many projects', () => {
    expect(() => resolveBacklogFilterId('42', MULTI_PROJECT)).toThrow(/ambiguous/);
  });

  it.each([
    ['abc'],
    [''],
    ['0'],
    ['-1'],
    ['1.5'],
    ['07'],
    ['9007199254740992'],
    ['github:acme/api#007'],
    ['gitlab:host/group/proj#'],
  ])('rejects the malformed filter id %j', argument => {
    expect(() => resolveBacklogFilterId(argument, PROVIDER_LOCAL)).toThrow(/not a valid identity/);
    expect(() => resolveBacklogFilterId(argument, MULTI_PROJECT)).toThrow(/not a valid identity/);
  });

  it('writes the identity of the provider own project as its issue number', () => {
    expect(renderBacklogId('github:org/repo#42' as WorkItemId, PROVIDER_LOCAL)).toBe('42');
  });

  it('keeps the canonical form of an identity of another project', () => {
    expect(renderBacklogId('gitlab:host/group/proj#7' as WorkItemId, PROVIDER_LOCAL)).toBe('gitlab:host/group/proj#7');
  });

  it('writes every identity canonically for a provider that reaches many projects', () => {
    expect(renderBacklogId('github:acme/api#42' as WorkItemId, MULTI_PROJECT)).toBe('github:acme/api#42');
    expect(renderBacklogId('github:org/repo#42' as WorkItemId, MULTI_PROJECT)).toBe('github:org/repo#42');
  });
});
