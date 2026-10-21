import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

function readClient(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../src/provider/${name}.ts`, import.meta.url)), 'utf8');
}

describe('the tracker state translations', () => {
  it('are written once in the GitHub client', () => {
    // GitHub calls an open issue "open"; AFK calls it "opened". The
    // rule used to be spelled out in four places that read a state and
    // two that asked for one, and a copy left behind reports an open
    // issue as a closed one. One place is the rule; another is a copy.
    const source = readClient('github-client');
    const forward = source.match(/'open'\s*\?|'opened'\s*\?/g) ?? [];
    expect(forward).toHaveLength(1);
  });

  it('are written once in the GitLab client', () => {
    // GitLab already speaks AFK's vocabulary, but the client still
    // spelled the rule out in four places.
    const source = readClient('gitlab-client');
    const forward = source.match(/'opened'\s*\?/g) ?? [];
    expect(forward).toHaveLength(1);
  });

  it('read every state through the rule', () => {
    const github = readClient('github-client');
    expect(github).toContain('function toTrackedState(');
    expect(github).toContain('function toTrackedMergeRequestState(');
    expect(github).toContain('function toGithubState(');
    expect(github).toContain('toTrackedState(data.state)');
    expect(github).toContain('toTrackedState(issue.state)');
    expect(github).toContain('toTrackedMergeRequestState(data.state, data.merged)');
    expect(github).toContain('toTrackedMergeRequestState(pr.state, !!mergedAt)');
    // The rule for asking GitHub, once defined and once for each of the
    // two listings that ask.
    expect(github.match(/toGithubState\(/g) ?? []).toHaveLength(3);

    const gitlab = readClient('gitlab-client');
    expect(gitlab).toContain('function toTrackedState(');
    expect(gitlab).toContain('function toTrackedMergeRequestState(');
    expect(gitlab).toContain('toTrackedState(issue.state)');
    expect(gitlab).toContain('toTrackedMergeRequestState(mr.state)');
  });
});
