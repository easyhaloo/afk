import { describe, expect, it } from 'vitest';
import { SANDBOX_KINDS, sandboxKindOf, type SandboxProviderName } from './types.js';

describe('the sandbox kind a provider runs in', () => {
  it('names the kinds there are', () => {
    expect([...SANDBOX_KINDS]).toEqual(['local', 'container']);
  });

  it('calls a container provider a container', () => {
    expect(sandboxKindOf('docker')).toBe('container');
    expect(sandboxKindOf('podman')).toBe('container');
  });

  it('calls the local provider local', () => {
    expect(sandboxKindOf('local')).toBe('local');
  });

  it('answers for every provider there is', () => {
    // The rule is asked once per run, by two runners. A provider the
    // rule does not know would have its transcript read from the wrong
    // place, and nothing would say so.
    const providers: SandboxProviderName[] = ['local', 'docker', 'podman'];
    for (const provider of providers) {
      expect(SANDBOX_KINDS).toContain(sandboxKindOf(provider));
    }
  });
});
