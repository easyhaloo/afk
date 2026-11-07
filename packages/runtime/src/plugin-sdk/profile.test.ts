import { describe, expect, it } from 'vitest';
import { resolveProfile, type PluginManifest } from './profile.js';

const eventStore: PluginManifest = { id: 'observe.event-store-jsonl', version: '1.0.0', apiVersion: 1, provides: ['event-store'], trusted: true };
const observer: PluginManifest = { id: 'observe.otel-console', version: '1.0.0', apiVersion: 1, provides: ['tracer', 'metrics'], requires: ['event-store'], trusted: true };

describe('resolveProfile', () => {
  it('resolves an explicit trusted capability composition', () => {
    const profile = resolveProfile({
      id: 'local-observe',
      plugins: [eventStore.id, observer.id],
      requiredCapabilities: ['event-store', 'tracer', 'metrics'],
    }, [eventStore, observer]);

    expect(profile.capabilities.get('event-store')?.map(manifest => manifest.id)).toEqual([eventStore.id]);
    expect(profile.capabilities.get('tracer')?.map(manifest => manifest.id)).toEqual([observer.id]);
  });

  it('rejects missing capabilities before any runtime starts', () => {
    expect(() => resolveProfile({ id: 'invalid', plugins: [observer.id], requiredCapabilities: ['tracer'] }, [eventStore, observer]))
      .toThrow(`plugin '${observer.id}' requires missing capability 'event-store'`);
  });

  it('supports several selected plugins providing one capability', () => {
    const first: PluginManifest = { id: 'agent.codex', version: '1.0.0', apiVersion: 1, provides: ['agent.provider'], trusted: true };
    const second: PluginManifest = { ...first, id: 'agent.opencode' };
    const profile = resolveProfile({ id: 'team', plugins: [first.id, second.id], requiredCapabilities: ['agent.provider'] }, [first, second]);
    expect(profile.capabilities.get('agent.provider')).toEqual([first, second]);
    expect(() => resolveProfile({ id: 'repeated', plugins: [first.id, first.id], requiredCapabilities: [] }, [first])).toThrow('more than once');
  });

  it('preserves a nested plugin configuration schema in the resolved manifest', () => {
    const manifest: PluginManifest = {
      ...eventStore,
      configSchema: {
        type: 'object',
        properties: {
          endpoint: { type: 'string', description: 'API endpoint' },
          retries: { type: 'integer', minimum: 0 },
          options: { type: 'array', items: { type: 'boolean' } },
        },
        required: ['endpoint'],
        additionalProperties: false,
      },
    };
    const resolved = resolveProfile({ id: 'configured', plugins: [manifest.id], requiredCapabilities: ['event-store'] }, [manifest]);

    expect(resolved.manifests[0].configSchema).toEqual(manifest.configSchema);
  });

  it('rejects afk-prefixed plugin ids', () => {
    expect(() => resolveProfile({ id: 'invalid-name', plugins: ['afk.bad'], requiredCapabilities: [] }, [
      { id: 'afk.bad', version: '1.0.0', apiVersion: 1, provides: [], trusted: true },
    ])).toThrow(/invalid plugin id/);
  });

  it('rejects conflicts regardless of plugin selection order', () => {
    expect(() => resolveProfile({ id: 'conflict', plugins: ['policy.one', 'policy.two'], requiredCapabilities: [] }, [
      { id: 'policy.one', version: '1.0.0', apiVersion: 1, provides: ['policy.provider'], conflicts: ['security.provider'], trusted: true },
      { id: 'policy.two', version: '1.0.0', apiVersion: 1, provides: ['security.provider'], trusted: true },
    ])).toThrow(/conflicts with 'security.provider'/);
  });
});
