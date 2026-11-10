import { describe, expect, it } from 'vitest';
import { rankChangeAssociations, selectChangeAssociation, type ChangeAssociationCandidate } from './change-association.js';

describe('change association', () => {
  it('takes the change that landed over every change that has not', () => {
    const candidates: ChangeAssociationCandidate[] = [
      { id: '48', state: 'closed', sourceBranch: 'afk/backlog-3-qa', targetBranch: 'master' },
      { id: '47', state: 'merged', sourceBranch: 'afk/backlog-3-qa', targetBranch: 'prd/27' },
    ];

    expect(selectChangeAssociation(candidates, { preferredTargetBranch: 'prd/27' })?.id).toBe('47');
  });

  it('takes the change that targets the expected branch among the open ones', () => {
    const candidates: ChangeAssociationCandidate[] = [
      { id: '50', state: 'open', sourceBranch: 'afk/backlog-3-qa', targetBranch: 'master' },
      { id: '49', state: 'open', sourceBranch: 'afk/backlog-3-qa', targetBranch: 'prd/27' },
    ];

    expect(selectChangeAssociation(candidates, { preferredTargetBranch: 'prd/27' })?.id).toBe('49');
  });

  it('takes the change that landed even when it targets another branch', () => {
    // The change that landed is the one the books are about. A change that is
    // still open towards the expected branch is a different fact: it is the
    // work that has not happened yet.
    const candidates: ChangeAssociationCandidate[] = [
      { id: '49', state: 'open', sourceBranch: 'afk/backlog-3-qa', targetBranch: 'prd/27' },
      { id: '47', state: 'merged', sourceBranch: 'afk/backlog-3-qa', targetBranch: 'master' },
    ];

    expect(selectChangeAssociation(candidates, { preferredTargetBranch: 'prd/27' })?.id).toBe('47');
  });

  it('takes the newer change of the same strength', () => {
    const candidates: ChangeAssociationCandidate[] = [
      { id: '47', state: 'open', sourceBranch: 'afk/backlog-3-qa', targetBranch: 'prd/27' },
      { id: '49', state: 'open', sourceBranch: 'afk/backlog-3-qa', targetBranch: 'prd/27' },
    ];

    expect(selectChangeAssociation(candidates, { preferredTargetBranch: 'prd/27' })?.id).toBe('49');
  });

  it('keeps a closed change as the last answer, so an item still has its change', () => {
    const candidates: ChangeAssociationCandidate[] = [
      { id: '48', state: 'closed', sourceBranch: 'afk/backlog-3-qa', targetBranch: 'prd/27' },
    ];

    expect(selectChangeAssociation(candidates, { preferredTargetBranch: 'prd/27' })?.id).toBe('48');
  });

  it('has no answer when the branch carries no change', () => {
    expect(selectChangeAssociation([], { preferredTargetBranch: 'prd/27' })).toBeNull();
  });

  it('does not change the order of the candidates it was given', () => {
    const candidates: ChangeAssociationCandidate[] = [
      { id: '48', state: 'closed', sourceBranch: 'afk/backlog-3-qa', targetBranch: 'master' },
      { id: '47', state: 'merged', sourceBranch: 'afk/backlog-3-qa', targetBranch: 'prd/27' },
    ];

    expect(rankChangeAssociations(candidates, { preferredTargetBranch: 'prd/27' }).map(candidate => candidate.id)).toEqual(['47', '48']);
    expect(candidates.map(candidate => candidate.id)).toEqual(['48', '47']);
  });
});
