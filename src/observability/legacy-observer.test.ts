import { afterEach, describe, expect, it } from 'vitest';
import { createLegacyRunObserverFromEnvironment, harnessMode } from './legacy-observer';

const originalMode = process.env.AFK_HARNESS_MODE;
const originalRoot = process.env.AFK_EVENT_STORE_DIR;

afterEach(() => {
  if (originalMode === undefined) delete process.env.AFK_HARNESS_MODE;
  else process.env.AFK_HARNESS_MODE = originalMode;
  if (originalRoot === undefined) delete process.env.AFK_EVENT_STORE_DIR;
  else process.env.AFK_EVENT_STORE_DIR = originalRoot;
});

describe('legacy observability bridge', () => {
  it('defaults to legacy behavior and enables dual-write only for an explicit mode', () => {
    delete process.env.AFK_HARNESS_MODE;
    expect(harnessMode()).toBe('legacy');
    expect(createLegacyRunObserverFromEnvironment()).toBeUndefined();

    process.env.AFK_HARNESS_MODE = 'observe';
    process.env.AFK_EVENT_STORE_DIR = '/tmp/afk-observe-test';
    expect(harnessMode()).toBe('observe');
    expect(createLegacyRunObserverFromEnvironment()).toBeDefined();
  });
});
