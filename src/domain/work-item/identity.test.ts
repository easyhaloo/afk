import { describe, expect, it } from 'vitest';
import {
  encodeWorkItemIdForPath,
  formatWorkItemId,
  parseWorkItemId,
} from './identity';

describe('work-item identity', () => {
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
