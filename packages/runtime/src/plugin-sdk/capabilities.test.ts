import { describe, expect, it } from 'vitest';
import {
  type ArtifactSink,
  type ContextSource,
  type CredentialProvider,
  type EventStoreProvider,
  type EvidenceStoreProvider,
  type MetricsProvider,
  type NotificationProvider,
  type PolicyCheckProvider,
  type RepositoryProvider,
  type TracerProvider,
  type TriggerProvider,
  type VerificationProvider,
} from './capabilities.js';

/** Builds a minimal provider of any kind to prove the contract is constructable. */
function stubProvider<K extends string>(id: string, capabilities: Readonly<Record<K, boolean>>) {
  return { id, capabilities };
}

describe('plugin capability contracts', () => {
  it('constructs a VerificationProvider with a full capability record, health, and doctor', async () => {
    const provider: VerificationProvider = {
      ...stubProvider<'static-analysis' | 'test-execution' | 'custom-script'>('verify-local', {
        'static-analysis': true,
        'test-execution': true,
        'custom-script': false,
      }),
      async health() {
        return { status: 'ok' };
      },
      async doctor() {
        return [{ check: 'binary', ok: true }];
      },
      async verify(request) {
        expect(request.target).toBe('pkg');
        return { passed: true, durationMs: 3 };
      },
    };

    const controller = new AbortController();
    expect(provider.id).toBe('verify-local');
    expect(provider.capabilities['test-execution']).toBe(true);
    expect((await provider.health!({ signal: controller.signal })).status).toBe('ok');
    expect((await provider.doctor!()).length).toBeGreaterThan(0);
    expect((await provider.verify({ target: 'pkg' }, { signal: controller.signal })).passed).toBe(true);
  });

  it('constructs a NotificationProvider that reports delivery', async () => {
    const provider: NotificationProvider = {
      ...stubProvider<'direct-message' | 'channel-post' | 'mention'>('notify-slack', {
        'direct-message': true,
        'channel-post': true,
        mention: false,
      }),
      async notify(message) {
        return { delivered: true, channel: message.channel ?? 'default' };
      },
    };

    expect((await provider.notify({ title: 'hi', body: 'there' })).channel).toBe('default');
  });

  it('constructs a TriggerProvider that registers and unregisters', async () => {
    const registered: string[] = [];
    const provider: TriggerProvider = {
      ...stubProvider<'schedule' | 'webhook' | 'manual'>('trigger-cron', {
        schedule: true,
        webhook: false,
        manual: true,
      }),
      async register(trigger) {
        registered.push(trigger.id);
      },
      async unregister(triggerId) {
        registered.splice(registered.indexOf(triggerId), 1);
      },
    };

    await provider.register({ id: 'nightly', kind: 'schedule', schedule: '@daily' });
    expect(registered).toEqual(['nightly']);
    await provider.unregister('nightly');
    expect(registered).toEqual([]);
  });

  it('constructs a ContextSource that returns fragments', async () => {
    const provider: ContextSource = {
      ...stubProvider<'read-only' | 'summarize' | 'search'>('context-wiki', {
        'read-only': true,
        summarize: true,
        search: true,
      }),
      async gather(query) {
        expect(query.limit).toBe(1);
        return [{ content: 'doc', origin: 'wiki' }];
      },
    };

    expect((await provider.gather({ scope: 'wiki', prompt: 'q', limit: 1 }))[0]?.origin).toBe('wiki');
  });

  it('constructs a CredentialProvider that resolves a scoped secret', async () => {
    const provider: CredentialProvider = {
      ...stubProvider<'read' | 'rotate' | 'scoped-token'>('creds-vault', {
        read: true,
        rotate: false,
        'scoped-token': true,
      }),
      async resolve(ref) {
        return { secret: `s:${ref.name}` };
      },
    };

    expect((await provider.resolve({ name: 'token', scope: 'ci' })).secret).toBe('s:token');
  });

  it('constructs an ArtifactSink that returns a reference', async () => {
    const provider: ArtifactSink = {
      ...stubProvider<'write' | 'read' | 'list'>('artifacts-local', {
        write: true,
        read: true,
        list: true,
      }),
      async put(artifact) {
        return { uri: `mem://${artifact.name}`, name: artifact.name };
      },
    };

    const ref = await provider.put({ name: 'log.txt', mediaType: 'text/plain', bytes: new Uint8Array([1]) });
    expect(ref.uri).toBe('mem://log.txt');
  });

  it('constructs a RepositoryProvider that reports a snapshot', async () => {
    const provider: RepositoryProvider = {
      ...stubProvider<'read' | 'clone' | 'push'>('repo-git', { read: true, clone: true, push: false }),
      async snapshot(repository) {
        return { commit: 'abc', branch: repository.ref ?? 'main', dirty: false };
      },
    };

    expect((await provider.snapshot({ url: 'git@example', ref: 'develop' })).branch).toBe('develop');
  });

  it('constructs a PolicyCheckProvider that returns a decision', async () => {
    const provider: PolicyCheckProvider = {
      ...stubProvider<'pre-execution' | 'post-execution' | 'static-review'>('policy-allow', {
        'pre-execution': true,
        'post-execution': false,
        'static-review': true,
      }),
      async evaluate(input) {
        return { allowed: true, rule: input.action };
      },
    };

    expect((await provider.evaluate({ action: 'deploy' })).allowed).toBe(true);
  });

  it('constructs an EventStoreProvider that appends and reads', async () => {
    const store = new Map<string, unknown[]>();
    const provider: EventStoreProvider = {
      ...stubProvider<'append' | 'read' | 'verify'>('events-mem', {
        append: true,
        read: true,
        verify: true,
      }),
      async append(events) {
        for (const event of events) store.set(event.runId, [...(store.get(event.runId) ?? []), event]);
      },
      async read(runId) {
        return (store.get(runId) ?? []) as never;
      },
    };

    await provider.append([{ runId: 'r1', sequence: 0, type: 'start' }]);
    expect((await provider.read('r1'))[0]?.type).toBe('start');
  });

  it('constructs an EvidenceStoreProvider that stores and retrieves', async () => {
    const provider: EvidenceStoreProvider = {
      ...stubProvider<'put' | 'get' | 'classify'>('evidence-mem', {
        put: true,
        get: true,
        classify: true,
      }),
      async put(record) {
        return { uri: `ev://${record.id}`, name: record.id };
      },
      async get(id) {
        return { id, mediaType: 'text/plain', bytes: new Uint8Array() };
      },
    };

    expect((await provider.put({ id: 'e1', mediaType: 'image/png', bytes: new Uint8Array([1]) })).uri).toBe('ev://e1');
  });

  it('constructs a TracerProvider that starts spans and emits events', async () => {
    const spans: string[] = [];
    const provider: TracerProvider = {
      ...stubProvider<'span' | 'event' | 'baggage'>('tracer-otel', {
        span: true,
        event: true,
        baggage: true,
      }),
      async startSpan(name) {
        spans.push(name);
      },
      async addEvent() {
        /* no-op */
      },
    };

    await provider.startSpan('op', { traceId: 't', spanId: 's' });
    expect(spans).toEqual(['op']);
  });

  it('constructs a MetricsProvider that records samples', async () => {
    const samples: string[] = [];
    const provider: MetricsProvider = {
      ...stubProvider<'counter' | 'gauge' | 'histogram'>('metrics-console', {
        counter: true,
        gauge: true,
        histogram: false,
      }),
      async record(sample) {
        samples.push(sample.name);
      },
    };

    await provider.record({ name: 'builds', value: 1 });
    expect(samples).toEqual(['builds']);
  });
});
