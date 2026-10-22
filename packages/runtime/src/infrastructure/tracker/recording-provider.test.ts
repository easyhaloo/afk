import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RecordingBacklogProvider } from './recording-provider.js';
import { readTrackerStore } from './store.js';
import type { BacklogItem, BacklogProvider } from '../../domain/backlog/index.js';

const item: BacklogItem = {
  id: '229',
  title: 'Ship the thing',
  state: 'ready',
  executionMode: 'afk',
  tags: [],
  dependsOn: [],
  branchName: 'afk/backlog-229',
  providerRef: 'github:owner/repo#229',
};

function stubProvider(): BacklogProvider {
  return {
    async get(id: string) {
      if (id !== item.id) throw new Error(`backlog ${id} not found`);
      return item;
    },
    async list() { return [item]; },
    async create() { return item; },
    async claim() { return null; },
    async transition() { /* noop */ },
    async setExecutionMode() { /* noop */ },
    async createRework() { throw new Error('not supported'); },
    async getActiveRework() { return undefined; },
    async resolveRework() { /* noop */ },
    async addTag() { /* noop */ },
    async removeTag() { /* noop */ },
    async initialize() { /* noop */ },
    async isRunnable() { return true; },
  };
}

describe('recording backlog provider', () => {
  let directory: string;
  let repository: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'afk-recording-provider-'));
    repository = mkdtempSync(join(tmpdir(), 'afk-recording-repo-'));
    mkdirSync(join(repository, '.git'), { recursive: true });
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
    rmSync(repository, { recursive: true, force: true });
  });

  it('records the project, the repository and the issue it read', async () => {
    const provider = new RecordingBacklogProvider(
      stubProvider(),
      { platform: 'github', project: 'owner/repo' },
      repository,
      directory,
    );

    await provider.get('229');

    const store = readTrackerStore(directory);
    expect(store.projects['github::owner/repo']).toMatchObject({
      platform: 'github',
      project: 'owner/repo',
      paths: [repository],
    });
    expect(store.projects['github::owner/repo'].issues['229']).toMatchObject({ title: 'Ship the thing' });
  });

  it('records every issue of a listing', async () => {
    const provider = new RecordingBacklogProvider(
      stubProvider(),
      { platform: 'github', project: 'owner/repo' },
      repository,
      directory,
    );

    await provider.list();

    expect(Object.keys(readTrackerStore(directory).projects['github::owner/repo'].issues)).toEqual(['229']);
  });

  it('keeps a GitLab instance host with the project', async () => {
    const provider = new RecordingBacklogProvider(
      stubProvider(),
      { platform: 'gitlab', project: 'team/api', host: 'git.corp' },
      repository,
      directory,
    );

    await provider.get('229');

    expect(readTrackerStore(directory).projects['gitlab:git.corp:team/api']).toMatchObject({
      platform: 'gitlab',
      project: 'team/api',
      host: 'git.corp',
    });
  });
});
