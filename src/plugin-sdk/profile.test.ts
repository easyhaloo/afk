import { describe, expect, it } from 'vitest';
import { resolveProfile, type PluginManifest } from './profile';

const eventStore: PluginManifest = { id: 'event-store-jsonl', apiVersion: 1, provides: ['event-store'], trusted: true };
const observer: PluginManifest = { id: 'otel-console', apiVersion: 1, provides: ['tracer', 'metrics'], requires: ['event-store'], trusted: true };

describe('resolveProfile', () => {
  it('resolves an explicit trusted capability composition', () => {
    const profile = resolveProfile({
      id: 'local-observe',
      plugins: ['event-store-jsonl', 'otel-console'],
      requiredCapabilities: ['event-store', 'tracer', 'metrics'],
    }, [eventStore, observer]);

    expect(profile.capabilities.get('event-store')?.id).toBe('event-store-jsonl');
    expect(profile.capabilities.get('tracer')?.id).toBe('otel-console');
  });

  it('rejects missing and duplicate capabilities before any runtime starts', () => {
    expect(() => resolveProfile({ id: 'invalid', plugins: ['otel-console'], requiredCapabilities: ['tracer'] }, [eventStore, observer]))
      .toThrow("plugin 'otel-console' requires missing capability 'event-store'");
    expect(() => resolveProfile({ id: 'duplicate', plugins: ['event-store-jsonl', 'other'], requiredCapabilities: ['event-store'] }, [
      eventStore,
      { id: 'other', apiVersion: 1, provides: ['event-store'], trusted: true },
    ])).toThrow("duplicate 'event-store' providers");
  });
});
