import { describe, expect, it } from 'vitest';
import { classifyError } from './errors.js';

describe('runtime error classification', () => {
  it.each([
    ['missing GITHUB_TOKEN', 'auth'], ['missing GITLAB_TOKEN', 'auth'],
    ['404: project not found', 'not_found'], ['invalid request', 'validation'], ['expected a string', 'validation'],
    ['HTTP 503', 'provider'], ['unexpected failure', 'unknown'],
  ])('classifies %s as %s for both applications', (message, code) => {
    expect(classifyError(new Error(message))).toBe(code);
    expect(classifyError(message)).toBe(code);
  });
});
