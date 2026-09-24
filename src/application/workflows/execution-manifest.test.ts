import { describe, expect, it } from 'vitest';
import { parseExecutionManifest, readExecutionManifest } from './execution-manifest';

const manifestPath = '/workspace/.afk/execution-manifest.json';
const backlogId = 'github:acme/api#42';

function validManifest() {
  return {
    schemaVersion: 1,
    workItemId: backlogId,
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

describe('parseExecutionManifest', () => {
  const missingTracker = validManifest();
  Reflect.deleteProperty(missingTracker, 'tracker');

  it('parses a schemaVersion 1 multi-repository manifest', () => {
    const manifest = parseExecutionManifest(validManifest(), { manifestPath, backlogId });

    expect(manifest).toMatchObject({
      schemaVersion: 1,
      workItemId: backlogId,
      providerBacklogId: '42',
      workingBranch: 'afk/work-item-42',
      repositories: [
        { projectKey: 'acme/api', baseBranch: 'main', primary: true },
        { projectKey: 'git.corp/acme/web', providerHost: 'git.corp', baseBranch: 'develop', primary: false },
      ],
    });
  });

  it('preserves tracker identity and provider Issue ID when the secondary repository is primary', () => {
    const value = validManifest();
    value.repositories[0].primary = false;
    value.repositories[1].primary = true;

    expect(parseExecutionManifest(value, { manifestPath, backlogId })).toMatchObject({
      providerBacklogId: '42',
      tracker: { platform: 'github', projectKey: 'acme/api', providerProjectId: '101' },
      repositories: [
        { projectKey: 'acme/api', primary: false },
        { platform: 'gitlab', projectKey: 'git.corp/acme/web', primary: true },
      ],
    });
  });

  it.each([
    ['non-object manifest', null, /manifest must be an object/],
    ['unknown manifest field', { ...validManifest(), extra: true }, /manifest has unknown field: extra/],
    ['unknown repository field', {
      ...validManifest(),
      repositories: [{ ...validManifest().repositories[0], extra: true }],
    }, /repositories\[0\] has unknown field: extra/],
    ['unsupported version', { ...validManifest(), schemaVersion: 2 }, /schemaVersion must be 1/],
    ['invalid provider backlog id', { ...validManifest(), providerBacklogId: 'WI-42' }, /providerBacklogId.*positive integer/],
    ['missing tracker', missingTracker, /tracker must be an object/],
    ['malformed tracker', { ...validManifest(), tracker: null }, /tracker must be an object/],
    ['invalid tracker platform', { ...validManifest(), tracker: { platform: 'bitbucket', projectKey: 'acme/api' } }, /tracker\.platform must be github or gitlab/],
    ['missing tracker project key', { ...validManifest(), tracker: { platform: 'github' } }, /tracker\.projectKey/],
    ['empty repositories', { ...validManifest(), repositories: [] }, /repositories must be a non-empty array/],
    ['zero primary repositories', {
      ...validManifest(),
      repositories: validManifest().repositories.map(repository => ({ ...repository, primary: false })),
    }, /exactly one primary/],
    ['multiple primary repositories', {
      ...validManifest(),
      repositories: validManifest().repositories.map(repository => ({ ...repository, primary: true })),
    }, /exactly one primary/],
    ['duplicate repository identity', {
      ...validManifest(),
      repositories: [validManifest().repositories[0], {
        ...validManifest().repositories[1],
        platform: 'github',
        projectKey: 'acme/api',
      }],
    }, /duplicate repository: github:acme\/api/],
    ['duplicate checkout path', {
      ...validManifest(),
      repositories: [validManifest().repositories[0], {
        ...validManifest().repositories[1],
        checkoutPath: 'repositories/API',
      }],
    }, /duplicate checkoutPath/],
    ['checkout path traversal', {
      ...validManifest(),
      repositories: [{ ...validManifest().repositories[0], checkoutPath: '../api' }],
    }, /repositories\[0\]\.checkoutPath must not traverse directories/],
    ['invalid branch', {
      ...validManifest(),
      repositories: [{ ...validManifest().repositories[0], baseBranch: 'refs/../main' }],
    }, /repositories\[0\]\.baseBranch is invalid/],
    ['invalid working branch', { ...validManifest(), workingBranch: 'refs/../work' }, /workingBranch is invalid/],
    ['repository branch mismatch', {
      ...validManifest(),
      repositories: [{ ...validManifest().repositories[0], workingBranch: 'other' }],
    }, /repositories\[0\]\.workingBranch must match workingBranch/],
    ['work item mismatch', validManifest(), /workItemId must match --backlog-id other-id/],
  ])('rejects %s with path and field context', (_name, value, pattern) => {
    const expectedBacklogId = _name === 'work item mismatch' ? 'other-id' : backlogId;
    expect(() => parseExecutionManifest(value, { manifestPath, backlogId: expectedBacklogId }))
      .toThrow(new RegExp(`${manifestPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}.*${pattern.source}`, 'i'));
  });
});

describe('readExecutionManifest', () => {
  it('resolves repository roots from the execution workspace containing the manifest', async () => {
    const manifest = await readExecutionManifest(manifestPath, backlogId, {
      readFile: async () => JSON.stringify(validManifest()),
    });

    expect(manifest.workspaceRoot).toBe('/workspace');
    expect(manifest.repositories.map(repository => repository.repoRoot)).toEqual([
      '/workspace/repositories/api',
      '/workspace/repositories/web',
    ]);
  });

  it('diagnoses missing files with the resolved manifest path', async () => {
    const error = Object.assign(new Error('missing'), { code: 'ENOENT' });
    await expect(readExecutionManifest('relative/manifest.json', backlogId, {
      cwd: '/invocation',
      readFile: async () => { throw error; },
    })).rejects.toThrow(/\/invocation\/relative\/manifest\.json.*does not exist/i);
  });

  it('diagnoses invalid JSON with the manifest path', async () => {
    await expect(readExecutionManifest(manifestPath, backlogId, {
      readFile: async () => '{bad json',
    })).rejects.toThrow(/\/workspace\/\.afk\/execution-manifest\.json.*invalid JSON/i);
  });
});
