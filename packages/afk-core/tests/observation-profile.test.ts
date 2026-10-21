import { describe, expect, it } from 'vitest';
import { DEFAULT_OBSERVATION_PROFILE, observationProfile } from '../src/events.js';

describe('observationProfile', () => {
  it('names the profile the environment gives', () => {
    expect(observationProfile('local-github-codex')).toBe('local-github-codex');
  });

  it('falls back to the default when nobody names one', () => {
    expect(observationProfile(undefined)).toBe(DEFAULT_OBSERVATION_PROFILE);
  });

  it('falls back to the default when the environment names nothing', () => {
    // `AFK_PROFILE=` in a shell or a .env names no profile, and an empty
    // one would leave the audit trail under a profile that no reader
    // could name.
    expect(observationProfile('')).toBe(DEFAULT_OBSERVATION_PROFILE);
    expect(observationProfile('   ')).toBe(DEFAULT_OBSERVATION_PROFILE);
  });

  it('keeps a name that has spaces around it', () => {
    expect(observationProfile('  local  ')).toBe('local');
  });
});
