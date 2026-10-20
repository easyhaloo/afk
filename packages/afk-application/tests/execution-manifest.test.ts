import { describe, expect, it } from 'vitest';
import { parseExecutionManifestDocument } from '../src/index.js';

function validManifest() {
  return {
    schemaVersion: 1,
    workItemId: 'github:acme/api#42',
    providerBacklogId: '42',
    tracker: { platform: 'github', projectKey: 'acme/api', providerProjectId: '101' },
    workingBranch: 'afk/work-item-42',
    repositories: [
      {
        platform: 'github',
        projectKey: 'acme/api',
        providerProjectId: '101',
        name: 'api',
        checkoutPath: 'repositories/api',
        baseBranch: 'main',
        role: 'backend',
        workingBranch: 'afk/work-item-42',
        primary: true,
      },
      {
        platform: 'gitlab',
        projectKey: 'git.corp/acme/web',
        providerHost: 'git.corp',
        name: 'web',
        checkoutPath: 'repositories/web',
        baseBranch: 'develop',
        workingBranch: 'afk/work-item-42',
        primary: false,
      },
    ],
  };
}

describe('the execution manifest grammar', () => {
  it('reads a schemaVersion 1 multi-repository manifest', () => {
    expect(parseExecutionManifestDocument(validManifest())).toMatchObject({
      schemaVersion: 1,
      workItemId: 'github:acme/api#42',
      providerBacklogId: '42',
      tracker: { platform: 'github', projectKey: 'acme/api', providerProjectId: '101' },
      repositories: [
        { projectKey: 'acme/api', baseBranch: 'main', primary: true },
        { platform: 'gitlab', projectKey: 'git.corp/acme/web', baseBranch: 'develop', primary: false },
      ],
    });
  });

  it('keeps the tracker identity when the secondary repository is primary', () => {
    const value = validManifest();
    value.repositories[0].primary = false;
    value.repositories[1].primary = true;

    expect(parseExecutionManifestDocument(value)).toMatchObject({
      providerBacklogId: '42',
      tracker: { platform: 'github', projectKey: 'acme/api', providerProjectId: '101' },
      repositories: [
        { projectKey: 'acme/api', primary: false },
        { projectKey: 'git.corp/acme/web', primary: true },
      ],
    });
  });

  it('names a work item the way the runners parse it', () => {
    // Both runners read the manifest's work item id with the identity
    // grammar before they act on it, so a manifest that names anything
    // else describes a run that cannot happen.
    expect(() => parseExecutionManifestDocument({ ...validManifest(), workItemId: 'WI-2026-018' }))
      .toThrow(/workItemId must be a canonical work item id/);
    expect(() => parseExecutionManifestDocument({ ...validManifest(), workItemId: '../task' }))
      .toThrow(/workItemId must be a canonical work item id/);
  });

  it.each([
    ['a tracker project key with an empty path segment', {
      ...validManifest(),
      tracker: { platform: 'github', projectKey: 'acme//api' },
    }, /tracker\.projectKey is invalid/],
    ['a tracker project key with a colon', {
      ...validManifest(),
      tracker: { platform: 'github', projectKey: 'acme:api' },
    }, /tracker\.projectKey is invalid/],
    ['a repository project key with an empty path segment', {
      ...validManifest(),
      repositories: [{ ...validManifest().repositories[0], projectKey: 'acme//api' }, validManifest().repositories[1]],
    }, /repositories\[0\]\.projectKey is invalid/],
    ['an unknown platform', {
      ...validManifest(),
      tracker: { platform: 'bitbucket', projectKey: 'acme/api' },
    }, /tracker\.platform must be one of: github, gitlab/],
    ['an unknown manifest field', { ...validManifest(), extra: true }, /manifest has unknown field: extra/],
    ['an unknown repository field', {
      ...validManifest(),
      repositories: [{ ...validManifest().repositories[0], extra: true }, validManifest().repositories[1]],
    }, /repositories\[0\] has unknown field: extra/],
    ['an unsupported version', { ...validManifest(), schemaVersion: 2 }, /schemaVersion must be 1/],
    ['a provider backlog id that is not a number', { ...validManifest(), providerBacklogId: 'WI-42' }, /providerBacklogId.*positive integer/],
    ['no repositories', { ...validManifest(), repositories: [] }, /repositories must be a non-empty array/],
    ['no primary repository', {
      ...validManifest(),
      repositories: validManifest().repositories.map(repository => ({ ...repository, primary: false })),
    }, /exactly one primary/],
    ['two primary repositories', {
      ...validManifest(),
      repositories: validManifest().repositories.map(repository => ({ ...repository, primary: true })),
    }, /exactly one primary/],
    ['the same repository twice', {
      ...validManifest(),
      repositories: [validManifest().repositories[0], {
        ...validManifest().repositories[1],
        platform: 'github',
        projectKey: 'acme/api',
      }],
    }, /duplicate repository: github:acme\/api/],
    ['the same checkout path twice', {
      ...validManifest(),
      repositories: [validManifest().repositories[0], {
        ...validManifest().repositories[1],
        checkoutPath: 'repositories/API',
      }],
    }, /duplicate checkoutPath/],
    ['a checkout path that traverses', {
      ...validManifest(),
      repositories: [{ ...validManifest().repositories[0], checkoutPath: '../api' }, validManifest().repositories[1]],
    }, /repositories\[0\]\.checkoutPath must not traverse directories/],
    ['a repository branch that differs from the manifest branch', {
      ...validManifest(),
      repositories: [{ ...validManifest().repositories[0], workingBranch: 'other' }, validManifest().repositories[1]],
    }, /repositories\[0\]\.workingBranch must match workingBranch/],
  ])('refuses %s', (_name, value, pattern) => {
    expect(() => parseExecutionManifestDocument(value)).toThrow(pattern);
  });
});
