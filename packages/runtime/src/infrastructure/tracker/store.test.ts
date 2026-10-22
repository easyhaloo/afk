import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  findProjectByIssue,
  findProjectByName,
  findProjectByPath,
  readTrackerStore,
  recordTrackerActivity,
  trackerIdentityOf,
} from './store.js';

describe('tracker store', () => {
  let stateRoot: string;
  let workspace: string;

  beforeEach(() => {
    stateRoot = mkdtempSync(join(tmpdir(), 'afk-tracker-store-'));
    workspace = mkdtempSync(join(tmpdir(), 'afk-tracker-workspace-'));
  });

  afterEach(() => {
    rmSync(stateRoot, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  });

  it('records the project, the repository root and the issues it saw', () => {
    const repository = join(workspace, 'repo');
    mkdirSync(join(repository, '.git'), { recursive: true });

    recordTrackerActivity({
      platform: 'github',
      project: 'owner/repo',
      cwd: join(repository, 'packages', 'api'),
      issues: [{ id: '229', title: 'Ship the thing' }],
    }, stateRoot);

    const store = readTrackerStore(stateRoot);
    const record = store.projects['github::owner/repo'];
    expect(record).toMatchObject({ platform: 'github', project: 'owner/repo' });
    expect(record.paths).toEqual([repository]);
    expect(record.issues['229']).toMatchObject({ title: 'Ship the thing' });
  });

  it('does not record a directory that is not a repository', () => {
    recordTrackerActivity({ platform: 'github', project: 'owner/repo', cwd: workspace }, stateRoot);

    expect(readTrackerStore(stateRoot).projects['github::owner/repo'].paths).toEqual([]);
  });

  it('finds the project that owns an issue id', () => {
    recordTrackerActivity({ platform: 'github', project: 'owner/repo', issues: [{ id: '229' }] }, stateRoot);
    recordTrackerActivity({ platform: 'gitlab', project: 'group/project', issues: [{ id: '7' }] }, stateRoot);

    const store = readTrackerStore(stateRoot);
    expect(findProjectByIssue(store, '229')?.project).toBe('owner/repo');
    expect(findProjectByIssue(store, '7')?.project).toBe('group/project');
    expect(findProjectByIssue(store, '404')).toBeUndefined();
  });

  it('prefers the project that owns the working directory when several carry the id', () => {
    const first = join(workspace, 'first');
    const second = join(workspace, 'second');
    mkdirSync(join(first, '.git'), { recursive: true });
    mkdirSync(join(second, '.git'), { recursive: true });

    recordTrackerActivity({ platform: 'github', project: 'owner/one', cwd: first, issues: [{ id: '229' }] }, stateRoot);
    recordTrackerActivity({ platform: 'github', project: 'owner/two', cwd: second, issues: [{ id: '229' }] }, stateRoot);

    const store = readTrackerStore(stateRoot);
    expect(findProjectByIssue(store, '229', first)?.project).toBe('owner/one');
    expect(findProjectByIssue(store, '229', second)?.project).toBe('owner/two');
  });

  it('finds the project that owns a working directory, most specific first', () => {
    const outer = join(workspace, 'outer');
    const inner = join(outer, 'inner');
    mkdirSync(join(outer, '.git'), { recursive: true });
    mkdirSync(join(inner, '.git'), { recursive: true });

    recordTrackerActivity({ platform: 'github', project: 'owner/outer', cwd: outer }, stateRoot);
    recordTrackerActivity({ platform: 'github', project: 'owner/inner', cwd: inner }, stateRoot);

    const store = readTrackerStore(stateRoot);
    expect(findProjectByPath(store, inner)?.project).toBe('owner/inner');
    expect(findProjectByPath(store, outer)?.project).toBe('owner/outer');
    expect(findProjectByPath(store, workspace)).toBeUndefined();
  });

  it('keeps a GitLab instance apart from the same project path on another host', () => {
    recordTrackerActivity({ platform: 'gitlab', project: 'team/api', host: 'git.corp', issues: [{ id: '3' }] }, stateRoot);
    recordTrackerActivity({ platform: 'gitlab', project: 'team/api', host: 'gitlab.com', issues: [{ id: '3' }] }, stateRoot);

    const store = readTrackerStore(stateRoot);
    expect(Object.keys(store.projects)).toHaveLength(2);
    expect(findProjectByName(store, 'team/api')?.host).toBeDefined();
  });

  it('reads a damaged index as empty instead of failing', () => {
    writeFileSync(join(stateRoot, 'tracker-projects.json'), '{not json', 'utf8');

    expect(readTrackerStore(stateRoot)).toEqual({ version: 1, projects: {} });
  });

  it('splits the instance host off a GitLab project key', () => {
    expect(trackerIdentityOf({ platform: 'gitlab', projectKey: 'git.corp/team/api', providerHost: 'git.corp' }))
      .toEqual({ project: 'team/api', host: 'git.corp' });
    expect(trackerIdentityOf({ platform: 'github', projectKey: 'owner/repo' }))
      .toEqual({ project: 'owner/repo', host: undefined });
  });
});
