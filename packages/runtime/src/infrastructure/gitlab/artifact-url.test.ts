import { describe, expect, it } from 'vitest';
import { resolveGitLabArtifactUrl } from './artifact-url.js';

describe('resolveGitLabArtifactUrl', () => {
  it('resolves a relative upload path to the absolute GitLab attachment URL', () => {
    expect(
      resolveGitLabArtifactUrl('/team/project/uploads/abc123/evidence.log', 'https://gitlab.example.test'),
    ).toBe('https://gitlab.example.test/team/project/uploads/abc123/evidence.log');
  });

  it('leaves an absolute attachment URL untouched', () => {
    const absolute = 'https://gitlab.example.test/team/project/uploads/abc123/evidence.log';
    expect(resolveGitLabArtifactUrl(absolute, 'https://gitlab.example.test')).toBe(absolute);
  });

  it('adds the scheme when the instance is configured as a bare host name', () => {
    expect(resolveGitLabArtifactUrl('/uploads/abc123/evidence.log', 'gitlab.example.test')).toBe(
      'https://gitlab.example.test/uploads/abc123/evidence.log',
    );
  });

  it('keeps a subfolder installation prefix in the resolved URL', () => {
    expect(
      resolveGitLabArtifactUrl('/team/project/uploads/abc123/evidence.log', 'https://host.test/gitlab'),
    ).toBe('https://host.test/gitlab/team/project/uploads/abc123/evidence.log');
  });

  it('accepts an upload path without a leading slash', () => {
    expect(resolveGitLabArtifactUrl('uploads/abc123/evidence.log', 'https://gitlab.example.test')).toBe(
      'https://gitlab.example.test/uploads/abc123/evidence.log',
    );
  });

  it('returns an empty string when the upload produced no path', () => {
    expect(resolveGitLabArtifactUrl(undefined, 'https://gitlab.example.test')).toBe('');
    expect(resolveGitLabArtifactUrl('   ', 'https://gitlab.example.test')).toBe('');
  });
});
