import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { PluginRuntime } from './runtime.js';
import { createPluginRunObserver } from './observability.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

it('discovers generic and specialized registrations and exports each provider only once', async () => {
  const root = await mkdtemp(join(tmpdir(), 'registered-observer-'));
  roots.push(root);
  const runtime = new PluginRuntime();
  const record = vi.fn(async () => undefined);
  const provider = { id: 'shared', capabilities: { counter: true, histogram: false, gauge: false }, record };
  await runtime.load({
    manifest: { id: 'observability.custom', version: '1.0.0', apiVersion: 1, provides: ['observability.provider', 'observe.metrics'], trusted: true },
    activate(context) {
      context.registerObservabilityProvider(provider.id, provider);
      context.registerCapability('observe.metrics', provider.id, provider);
    },
  });
  try {
    await createPluginRunObserver(runtime, root).record({ traceId: 't', runId: 'r', workItemId: 'github:org/repo#1', profileId: 'local', attempt: 1, actor: { kind: 'cli', id: 'test' } }, { kind: 'run.started' });
    expect(record).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ kind: 'counter', value: 1 }), expect.anything());
  } finally { await runtime.dispose(); }
});

it.each(['tracing', 'metrics', 'event-store'] as const)('limits a specialized %s registration to its declared signal', async signal => {
  const root = await mkdtemp(join(tmpdir(), 'specialized-observer-'));
  roots.push(root);
  const runtime = new PluginRuntime();
  const provider = {
    id: 'combined', capabilities: { span: true, event: true, counter: true, histogram: true, append: true },
    startSpan: vi.fn(async () => undefined), addEvent: vi.fn(async () => undefined), endSpan: vi.fn(async () => undefined),
    record: vi.fn(async () => undefined), append: vi.fn(async () => undefined),
  };
  await runtime.load({
    manifest: { id: 'observability.specialized', version: '1.0.0', apiVersion: 1, provides: [`observe.${signal}`], trusted: true },
    activate: context => context.registerCapability(`observe.${signal}`, provider.id, provider),
  });
  try {
    await createPluginRunObserver(runtime, root).record({ traceId: 't', runId: 'r', workItemId: 'github:org/repo#1', profileId: 'local', attempt: 1, actor: { kind: 'cli', id: 'test' } }, { kind: 'run.started' });
    expect(provider.startSpan).toHaveBeenCalledTimes(signal === 'tracing' ? 1 : 0);
    expect(provider.addEvent).toHaveBeenCalledTimes(signal === 'tracing' ? 1 : 0);
    expect(provider.endSpan).toHaveBeenCalledTimes(signal === 'tracing' ? 1 : 0);
    expect(provider.record).toHaveBeenCalledTimes(signal === 'metrics' ? 2 : 0);
    expect(provider.append).toHaveBeenCalledTimes(signal === 'event-store' ? 1 : 0);
  } finally { await runtime.dispose(); }
});
