import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitHubClient } from './client.js';

describe('GitHubClient', () => {
  it('scopes relationship reads to the specified repository', async () => {
    const client = new GitHubClient({ repo: 'org/code', auth: 'test-token' });
    const scoped = client.forProject('org/other');
    expect(scoped.projectId).toBe('org/other');
    const get = vi.fn().mockResolvedValue({ data: { number: 7, title: 'Remote', labels: [], state: 'open', html_url: 'https://example/7' } });
    (scoped as any).client = { issues: { get } };
    await scoped.getIssue(7);
    expect(get).toHaveBeenCalledWith({ owner: 'org', repo: 'other', issue_number: 7 });
  });
  it('reads the PR-side closing issue references for open PRs', async () => {
    const client = new GitHubClient({ repo: 'owner/code', auth: 'test-token' });
    const graphql = vi.fn().mockResolvedValue({ repository: { pullRequest: { closingIssuesReferences: {
      nodes: [{ number: 158, repository: { nameWithOwner: 'owner/issues' } }],
    } } } });
    (client as unknown as { client: { graphql: typeof graphql } }).client = { graphql };
    await expect(client.isMRLinkedToIssue(9, 'github:owner/issues#158')).resolves.toBe(true);
    expect(graphql).toHaveBeenCalledWith(expect.stringContaining('closingIssuesReferences'), expect.objectContaining({ owner: 'owner', repo: 'code', pullRequest: 9 }));
    graphql.mockResolvedValue({ repository: null });
    await expect(client.isMRLinkedToIssue(9, 'github:owner/issues#158')).rejects.toThrow(/unavailable/i);
  });

  it('rejects references to another issue or repository', async () => {
    const client = new GitHubClient({ repo: 'owner/code', auth: 'test-token' });
    const graphql = vi.fn().mockResolvedValue({ repository: { pullRequest: { closingIssuesReferences: {
      nodes: [{ number: 9, repository: { nameWithOwner: 'owner/other' } }],
    } } } });
    (client as unknown as { client: { graphql: typeof graphql } }).client = { graphql };
    await expect(client.isMRLinkedToIssue(9, 'github:owner/issues#158')).resolves.toBe(false);
    graphql.mockResolvedValue({ repository: { pullRequest: { closingIssuesReferences: { nodes: [] } } } });
    await expect(client.isMRLinkedToIssue(9, 'github:owner/issues#158')).resolves.toBe(false);
  });

  it('requires authentication before constructing a client', () => {
    expect(() => new GitHubClient({ repo: 'owner/repo' })).toThrow(/requires auth token/);
  });

  it('extracts label acceptance criteria for the configured repository', () => {
    const client = new GitHubClient({ repo: 'owner/repo', auth: 'test-token' });
    expect(client.projectId).toBe('owner/repo');
    expect(client.parseAC({ labels: ['ac::1::Checks pass'], description: '## AC\n- [ ] Ignored fallback' }))
      .toEqual({ source: 'labels', items: [{ index: 1, text: 'Checks pass', evidenceType: 'none', checkCommand: '' }] });
  });
});

describe('GitHubClient.uploadArtifacts', () => {
  function stubClient(overrides: {
    releases?: Array<{ id: number; tag_name: string }>;
    assets?: Array<{ id: number; name: string }>;
    upload?: (name: string) => { data: { browser_download_url: string } };
  } = {}) {
    const listReleases = vi.fn().mockResolvedValue({ data: overrides.releases ?? [] });
    const createRelease = vi.fn().mockResolvedValue({ data: { id: 42 } });
    const listReleaseAssets = vi.fn().mockResolvedValue({ data: overrides.assets ?? [] });
    const deleteReleaseAsset = vi.fn().mockResolvedValue({ data: {} });
    const uploadReleaseAsset = vi.fn(async ({ name }: { name: string }) =>
      overrides.upload ? overrides.upload(name) : { data: { browser_download_url: `https://github.test/${name}` } });
    const client = new GitHubClient({ repo: 'owner/code', auth: 'test-token' });
    (client as unknown as { client: unknown }).client = {
      repos: { listReleases, createRelease, listReleaseAssets, deleteReleaseAsset, uploadReleaseAsset },
    };
    return { client, listReleases, createRelease, listReleaseAssets, deleteReleaseAsset, uploadReleaseAsset };
  }

  async function worktreeWithManifest(lines: string[]): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'afk-github-artifacts-'));
    await mkdir(join(root, '.afk'), { recursive: true });
    await writeFile(join(root, '.afk', 'artifacts.txt'), lines.join('\n'), 'utf-8');
    return root;
  }

  it('uploads every registered artifact into a pre-release and returns their links', async () => {
    const root = await mkdtemp(join(tmpdir(), 'afk-github-artifacts-'));
    const shot = join(root, 'boot.png');
    const log = join(root, 'output.log');
    await writeFile(shot, 'png-bytes', 'utf-8');
    await writeFile(log, 'log-bytes', 'utf-8');
    await mkdir(join(root, '.afk'), { recursive: true });
    await writeFile(join(root, '.afk', 'artifacts.txt'), `${shot}\n${log}\n`, 'utf-8');
    const { client, createRelease, uploadReleaseAsset } = stubClient();

    await expect(client.uploadArtifacts(root, { backlogId: '229', sourceBranch: 'afk/backlog-229-qa' }))
      .resolves.toEqual([
        { name: 'boot.png', url: 'https://github.test/boot.png' },
        { name: 'output.log', url: 'https://github.test/output.log' },
      ]);

    expect(createRelease).toHaveBeenCalledWith(expect.objectContaining({
      tag_name: 'afk-qa-artifacts-229',
      draft: false,
      prerelease: true,
      target_commitish: 'afk/backlog-229-qa',
    }));
    expect(uploadReleaseAsset).toHaveBeenCalledTimes(2);
    expect(uploadReleaseAsset).toHaveBeenCalledWith(expect.objectContaining({
      release_id: 42, name: 'boot.png', headers: { 'content-type': 'application/octet-stream' },
    }));
    await rm(root, { recursive: true, force: true });
  });

  it('drops the previous file before re-uploading an artifact of the same name', async () => {
    const root = await mkdtemp(join(tmpdir(), 'afk-github-artifacts-'));
    const shot = join(root, 'boot.png');
    await writeFile(shot, 'png-bytes', 'utf-8');
    await mkdir(join(root, '.afk'), { recursive: true });
    await writeFile(join(root, '.afk', 'artifacts.txt'), `${shot}\n`, 'utf-8');
    const { client, deleteReleaseAsset, uploadReleaseAsset } = stubClient({
      releases: [{ id: 7, tag_name: 'afk-qa-artifacts-229' }],
      assets: [{ id: 99, name: 'boot.png' }],
    });

    await expect(client.uploadArtifacts(root, { backlogId: '229' })).resolves.toEqual([
      { name: 'boot.png', url: 'https://github.test/boot.png' },
    ]);
    expect(deleteReleaseAsset).toHaveBeenCalledWith({ owner: 'owner', repo: 'code', asset_id: 99 });
    expect(uploadReleaseAsset).toHaveBeenCalledWith(expect.objectContaining({ release_id: 7, name: 'boot.png' }));
    await rm(root, { recursive: true, force: true });
  });

  it('reuses the release it already created for the same backlog', async () => {
    const root = await worktreeWithManifest([]);
    const shot = join(root, 'boot.png');
    await writeFile(shot, 'png-bytes', 'utf-8');
    await writeFile(join(root, '.afk', 'artifacts.txt'), `${shot}\n`, 'utf-8');
    const { client, createRelease, uploadReleaseAsset } = stubClient({
      releases: [{ id: 7, tag_name: 'afk-qa-artifacts-229' }],
    });

    await expect(client.uploadArtifacts(root, { backlogId: '229' })).resolves.toEqual([
      { name: 'boot.png', url: 'https://github.test/boot.png' },
    ]);
    expect(createRelease).not.toHaveBeenCalled();
    expect(uploadReleaseAsset).toHaveBeenCalledWith(expect.objectContaining({ release_id: 7 }));
    await rm(root, { recursive: true, force: true });
  });

  it('uploads nothing when the run registered no artifacts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'afk-github-artifacts-'));
    const { client, createRelease, uploadReleaseAsset } = stubClient();

    await expect(client.uploadArtifacts(root, { backlogId: '229' })).resolves.toEqual([]);
    expect(createRelease).not.toHaveBeenCalled();
    expect(uploadReleaseAsset).not.toHaveBeenCalled();
    await rm(root, { recursive: true, force: true });
  });

  it('keeps the readable artifacts when one of them cannot be uploaded', async () => {
    const root = await mkdtemp(join(tmpdir(), 'afk-github-artifacts-'));
    const missing = join(root, 'gone.png');
    const shot = join(root, 'boot.png');
    await writeFile(shot, 'png-bytes', 'utf-8');
    await mkdir(join(root, '.afk'), { recursive: true });
    await writeFile(join(root, '.afk', 'artifacts.txt'), `${missing}\n${shot}\n`, 'utf-8');
    const { client } = stubClient();

    await expect(client.uploadArtifacts(root, { backlogId: '229' })).resolves.toEqual([
      { name: 'boot.png', url: 'https://github.test/boot.png' },
    ]);
    await rm(root, { recursive: true, force: true });
  });
});
