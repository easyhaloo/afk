import { describe, expect, it } from 'vitest';
import { rankChangeAssociations, scopeChangeCandidates, selectChangeAssociation, type ChangeAssociationCandidate } from './change-association.js';

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

  it('takes the change that is still open when the caller waits for a person', () => {
    // A branch that was reworked carries the change of the earlier round
    // that has landed and the change of the current round that is open. Only
    // the second one is the merge gate.
    const candidates: ChangeAssociationCandidate[] = [
      { id: '47', state: 'merged', sourceBranch: 'afk/backlog-9-qa', targetBranch: 'prd/27' },
      { id: '55', state: 'open', sourceBranch: 'afk/backlog-9-qa', targetBranch: 'prd/27' },
    ];

    expect(selectChangeAssociation(candidates, { intent: 'alive', preferredTargetBranch: 'prd/27' })?.id).toBe('55');
  });

  it('takes the change that is still open even when the one that landed aimed at the expected branch', () => {
    const candidates: ChangeAssociationCandidate[] = [
      { id: '47', state: 'merged', sourceBranch: 'afk/backlog-9-qa', targetBranch: 'prd/27' },
      { id: '55', state: 'open', sourceBranch: 'afk/backlog-9-qa', targetBranch: 'master' },
    ];

    expect(selectChangeAssociation(candidates, { intent: 'alive', preferredTargetBranch: 'prd/27' })?.id).toBe('55');
  });

  it('takes the change that targets the expected branch among the ones that are still open', () => {
    const candidates: ChangeAssociationCandidate[] = [
      { id: '50', state: 'open', sourceBranch: 'afk/backlog-3-qa', targetBranch: 'master' },
      { id: '49', state: 'open', sourceBranch: 'afk/backlog-3-qa', targetBranch: 'prd/27' },
    ];

    expect(selectChangeAssociation(candidates, { intent: 'alive', preferredTargetBranch: 'prd/27' })?.id).toBe('49');
  });

  it('keeps the change that landed the answer for the books of a finished item', () => {
    const candidates: ChangeAssociationCandidate[] = [
      { id: '49', state: 'open', sourceBranch: 'afk/backlog-3-qa', targetBranch: 'prd/27' },
      { id: '47', state: 'merged', sourceBranch: 'afk/backlog-3-qa', targetBranch: 'prd/27' },
    ];

    expect(selectChangeAssociation(candidates, { intent: 'landed', preferredTargetBranch: 'prd/27' })?.id).toBe('47');
  });

  it('scopes the candidates to the verification branch of the item', () => {
    const candidates = [
      { id: '47', sourceBranch: 'afk/backlog-3-qa' },
      { id: '46', sourceBranch: 'afk/backlog-3' },
    ];

    expect(scopeChangeCandidates(candidates, 'afk/backlog-3')).toEqual({
      scope: [{ id: '47', sourceBranch: 'afk/backlog-3-qa' }],
      others: [{ id: '46', sourceBranch: 'afk/backlog-3' }],
    });
  });

  it('falls back to the branch of the item when it carries no verification branch', () => {
    const candidates = [
      { id: '46', sourceBranch: 'afk/backlog-3' },
      { id: '40', sourceBranch: 'afk/backlog-40-qa' },
    ];

    expect(scopeChangeCandidates(candidates, 'afk/backlog-3')).toEqual({
      scope: [{ id: '46', sourceBranch: 'afk/backlog-3' }],
      others: [],
    });
  });
});
