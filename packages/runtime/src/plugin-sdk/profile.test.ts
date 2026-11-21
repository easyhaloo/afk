import { describe, expect, it } from 'vitest';
import { resolveProfile, validateManifest, type PluginManifest } from './profile.js';

const eventStore: PluginManifest = { id: 'observe.event-store-jsonl', version: '1.0.0', apiVersion: 1, provides: ['event-store'], trusted: true };
const observer: PluginManifest = { id: 'observe.otel-console', version: '1.0.0', apiVersion: 1, provides: ['tracer', 'metrics'], requires: ['event-store'], trusted: true };

const tool = {
  id: 'node', command: 'node', location: 'backend',
  version: { args: ['--version'], minimum: '22.16.0' },
  platforms: ['linux', 'darwin', 'win32'], architectures: ['x64', 'arm64'],
  source: { url: 'https://nodejs.org/en/download' },
};

describe('external tool declarations', () => {
  it('preserves declarations without resolving them as capabilities or executing them', () => {
    const manifest = { ...eventStore, externalTools: [tool] } as PluginManifest;
    const resolved = resolveProfile({ id: 'static', plugins: [manifest.id], requiredCapabilities: [] }, [manifest]);
    expect(resolved.manifests[0]).toEqual(manifest);
    expect([...resolved.capabilities.keys()]).toEqual(['event-store']);
    expect(() => validateManifest(eventStore)).not.toThrow();
  });

  it.each([
    null, {}, [null], [{ ...tool, id: '../node' }], [{ ...tool, command: 'node --eval' }],
    [{ ...tool, command: '/tmp/node' }], [{ ...tool, command: '-node' }],
    [{ ...tool, location: 'container' }], [{ ...tool, platforms: [] }],
    [{ ...tool, architectures: ['mystery'] }], [{ ...tool, platforms: ['linux', 'linux'] }],
    [{ ...tool, version: { args: [] } }], [{ ...tool, version: { args: ['--version\0'] } }],
    [{ ...tool, version: { args: ['--version'], minimum: '^22' } }],
    [{ ...tool, version: { args: ['--version'], minimum: '22.0.0-beta' } }],
    [{ ...tool, source: { url: 'http://nodejs.org' } }],
    [{ ...tool, source: { url: 'not-a-url' } }],
    [{ ...tool, source: { url: 'https://nodejs.org/\nprivate' } }],
    [{ ...tool, source: { url: 'https://user:secret@nodejs.org' } }],
    [{ ...tool, source: { url: 'https://nodejs.org?token=secret' } }],
    [{ ...tool, source: { url: 'https://nodejs.org/#secret' } }],
    [{ ...tool, install: ['curl', 'untrusted'] }], [tool, tool],
  ].map(value => [value]))('rejects malformed externalTools %# at the manifest boundary', externalTools => {
    expect(() => validateManifest({ ...eventStore, externalTools } as PluginManifest)).toThrow(/externalTools/);
  });

  it('allows declarations with unknown version support and no platform restriction', () => {
    expect(() => validateManifest({ ...eventStore, externalTools: [{
      id: 'jms', command: 'jms', location: 'host', source: { url: 'https://github.com/jumpserver/jms' },
    }] } as PluginManifest)).not.toThrow();
  });
});

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
