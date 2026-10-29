import { describe, expect, it } from 'vitest';
import {
  canonicalProjectKey,
  encodeWorkItemIdForPath,
  formatWorkItemId,
  gitLabProjectHost,
  parseWorkItemId,
} from './identity.js';

describe('work-item identity', () => {
  it('names a GitHub project by its owner and repository', () => {
    expect(canonicalProjectKey('github', 'openai/codex')).toBe('openai/codex');
    expect(() => canonicalProjectKey('github', 'openai')).toThrow('owner/repo');
  });

  it('keeps the gitlab.com project key it always had', () => {
    expect(canonicalProjectKey('gitlab', 'group/project', 'gitlab.com')).toBe('group/project');
    expect(canonicalProjectKey('gitlab', 'group/project')).toBe('group/project');
  });

  it('qualifies a self-hosted GitLab project with its instance host', () => {
    expect(canonicalProjectKey('gitlab', 'group/project', 'gitlab.corp')).toBe('gitlab.corp/group/project');
    expect(canonicalProjectKey('gitlab', 'gitlab.corp/group/project', 'gitlab.corp')).toBe('gitlab.corp/group/project');
  });

  it('reads the host of a GitLab project key only when it names one', () => {
    expect(gitLabProjectHost('gitlab.corp/group/project')).toBe('gitlab.corp');
    expect(gitLabProjectHost('group/project')).toBeUndefined();
    expect(gitLabProjectHost('group/subgroup/project')).toBeUndefined();
  });

  it('formats and parses a GitHub owner/repository identity', () => {
    const id = formatWorkItemId({ platform: 'github', projectKey: 'openai/codex', issueNumber: 42 });

    expect(id).toBe('github:openai/codex#42');
    expect(parseWorkItemId(id)).toEqual({
      id,
      platform: 'github',
      projectKey: 'openai/codex',
      issueNumber: 42,
    });
  });

  it('formats and parses a GitLab host/group/project identity', () => {
    const id = formatWorkItemId({
      platform: 'gitlab',
      projectKey: 'gitlab.example.com/platform/afk',
      issueNumber: 17,
    });

    expect(id).toBe('gitlab:gitlab.example.com/platform/afk#17');
    expect(parseWorkItemId(id)).toEqual({
      id,
      platform: 'gitlab',
      projectKey: 'gitlab.example.com/platform/afk',
      issueNumber: 17,
    });
  });

  it('keeps identical issue numbers distinct across projects', () => {
    const first = formatWorkItemId({ platform: 'github', projectKey: 'acme/api', issueNumber: 8 });
    const second = formatWorkItemId({ platform: 'github', projectKey: 'acme/web', issueNumber: 8 });

    expect(first).not.toBe(second);
  });

  it('round trips a GitLab identity with a non-default port', () => {
    const parts = { platform: 'gitlab' as const, projectKey: 'gitlab.example:8443/acme/api', issueNumber: 1 };
    const id = formatWorkItemId(parts);
    expect(parseWorkItemId(id)).toEqual({ ...parts, id });
  });

  it.each([
    '',
    'github:#1',
    'jira:acme/api#1',
    'github:acme/api',
    'github:acme/api#0',
    'github:acme/api#-1',
    'github:acme/api#1.5',
    'github:acme/api#01',
    'github:acme api#1',
    ' github:acme/api#1',
    'github:acme/api#1 ',
  ])('rejects malformed identity %j', value => {
    expect(() => parseWorkItemId(value)).toThrow();
  });

  it('encodes canonical identities as filesystem-safe directory names', () => {
    const id = formatWorkItemId({
      platform: 'gitlab',
      projectKey: 'gitlab.example.com/group/subgroup/project',
      issueNumber: 99,
    });
    const encoded = encodeWorkItemIdForPath(id);

    expect(encoded).not.toMatch(/[<>:"/\\|?*#]/);
    expect(encoded).not.toBe('.');
    expect(encoded).not.toBe('..');
    expect(encoded).toContain('gitlab');
    expect(encodeWorkItemIdForPath(id)).toBe(encoded);
  });
});
