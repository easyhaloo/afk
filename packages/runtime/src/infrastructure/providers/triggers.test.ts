import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { TriggerDescriptor } from '../../plugin-sdk/capabilities.js';
import {
  GitPushTriggerProvider,
  IssueEventTriggerProvider,
  ScheduleTriggerProvider,
  WebhookTriggerProvider,
  type WebhookEventHandler,
} from './triggers.js';

function sign(secret: string, body: string | Uint8Array): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

function abortedSignal(): AbortSignal {
  const controller = new AbortController();
  controller.abort();
  return controller.signal;
}

describe('WebhookTriggerProvider', () => {
  const secret = 'whsec_123';
  const rawBody = JSON.stringify({ event: 'push', payload: { ref: 'refs/heads/main' } });

  it('accepts a valid sha256 signature computed over the raw body', () => {
    const provider = new WebhookTriggerProvider({ secret });
    expect(provider.verifySignature(rawBody, sign(secret, rawBody))).toBe(true);
  });

  it('accepts a bare-hex signature without the sha256 prefix', () => {
    const provider = new WebhookTriggerProvider({ secret });
    const bare = createHmac('sha256', secret).update(rawBody).digest('hex');
    expect(provider.verifySignature(rawBody, bare)).toBe(true);
  });

  it('rejects a tampered body', () => {
    const provider = new WebhookTriggerProvider({ secret });
    const signature = sign(secret, rawBody);
    expect(provider.verifySignature(`${rawBody} `, signature)).toBe(false);
  });

  it('rejects wrong secrets, malformed and wrong-length signatures without throwing', () => {
    const provider = new WebhookTriggerProvider({ secret });
    expect(provider.verifySignature(rawBody, sign('other', rawBody))).toBe(false);
    expect(provider.verifySignature(rawBody, 'not-a-signature')).toBe(false);
    expect(provider.verifySignature(rawBody, 'sha256=deadbeef')).toBe(false);
  });

  it('dispatches a matching registered event to the callback', async () => {
    const onEvent = vi.fn<Parameters<WebhookEventHandler>, ReturnType<WebhookEventHandler>>(async () => undefined);
    const provider = new WebhookTriggerProvider({ secret, onEvent });
    await provider.register({ id: 't1', kind: 'webhook', payload: { event: 'push' } });

    const result = await provider.handle(rawBody, sign(secret, rawBody));

    expect(result.dispatched).toBe(1);
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEvent.mock.calls[0][0].name).toBe('push');
    expect(onEvent.mock.calls[0][0].payload).toMatchObject({ ref: 'refs/heads/main' });
    expect(onEvent.mock.calls[0][1].id).toBe('t1');
  });

  it('skips registered triggers whose event filter does not match', async () => {
    const onEvent = vi.fn(async () => undefined);
    const provider = new WebhookTriggerProvider({ secret, onEvent });
    await provider.register({ id: 'issues-only', kind: 'webhook', payload: { event: 'issues' } });

    const result = await provider.handle(rawBody, sign(secret, rawBody));

    expect(result.dispatched).toBe(0);
    expect(onEvent).not.toHaveBeenCalled();
  });

  it('throws on a bad signature and never invokes the callback', async () => {
    const onEvent = vi.fn(async () => undefined);
    const provider = new WebhookTriggerProvider({ secret, onEvent });
    await provider.register({ id: 't1', kind: 'webhook' });

    await expect(provider.handle(rawBody, 'sha256=00'.padEnd(71, '0'))).rejects.toThrow(/signature/i);
    expect(onEvent).not.toHaveBeenCalled();
  });

  it('throws on unparseable JSON even with a valid signature', async () => {
    const provider = new WebhookTriggerProvider({ secret });
    await provider.register({ id: 't1', kind: 'webhook' });

    await expect(provider.handle('not json', sign(secret, 'not json'))).rejects.toThrow(/payload/i);
  });

  it('respects cancellation', async () => {
    const onEvent = vi.fn(async () => undefined);
    const provider = new WebhookTriggerProvider({ secret, onEvent });
    await provider.register({ id: 't1', kind: 'webhook' });

    await expect(provider.handle(rawBody, sign(secret, rawBody), { signal: abortedSignal() })).rejects.toThrow();
    expect(onEvent).not.toHaveBeenCalled();
  });

  it('rejects duplicate ids and unknown unregistration, and disposes cleanly', async () => {
    const provider = new WebhookTriggerProvider({ secret });
    await provider.register({ id: 't1', kind: 'webhook' });
    await expect(provider.register({ id: 't1', kind: 'webhook' })).rejects.toThrow(/already registered/);
    await expect(provider.unregister('missing')).rejects.toThrow(/Unknown trigger/);
    await provider.dispose();
    await expect(provider.unregister('t1')).rejects.toThrow(/Unknown trigger/);
  });

  it('rejects a descriptor whose kind is not webhook', async () => {
    const provider = new WebhookTriggerProvider({ secret });
    await expect(provider.register({ id: 's1', kind: 'schedule', schedule: '100' })).rejects.toThrow(/webhook/);
  });
});

describe('GitPushTriggerProvider', () => {
  const push = {
    ref: 'refs/heads/main',
    after: 'abc123',
    pusher: { name: 'ci' },
  };

  it('dispatches a push matching the subscribed branch', async () => {
    const onPush = vi.fn(async () => undefined);
    const provider = new GitPushTriggerProvider({ onPush });
    await provider.register({ id: 'main-only', kind: 'webhook', payload: { branch: 'main' } });

    const result = await provider.handlePush(push);

    expect(result.dispatched).toBe(1);
    expect(onPush).toHaveBeenCalledWith(expect.objectContaining({ ref: 'refs/heads/main' }), expect.any(Object));
  });

  it('filters out pushes to other branches', async () => {
    const onPush = vi.fn(async () => undefined);
    const provider = new GitPushTriggerProvider({ onPush });
    await provider.register({ id: 'main-only', kind: 'webhook', payload: { branch: 'main' } });

    const result = await provider.handlePush({ ...push, ref: 'refs/heads/feature' });

    expect(result.dispatched).toBe(0);
    expect(onPush).not.toHaveBeenCalled();
  });

  it('drops branch deletions unless explicitly included', async () => {
    const onPush = vi.fn(async () => undefined);
    const provider = new GitPushTriggerProvider({ onPush });
    await provider.register({ id: 'all', kind: 'webhook' });

    await expect(provider.handlePush({ ...push, deleted: true })).resolves.toEqual({ dispatched: 0 });

    const permissive = new GitPushTriggerProvider({ onPush, includeDeleted: true });
    await permissive.register({ id: 'all', kind: 'webhook' });
    await expect(permissive.handlePush({ ...push, deleted: true })).resolves.toEqual({ dispatched: 1 });
  });

  it('matches a bare branch name as well as a full ref', async () => {
    const onPush = vi.fn(async () => undefined);
    const provider = new GitPushTriggerProvider({ onPush });
    await provider.register({ id: 'bare', kind: 'webhook', payload: { branch: 'release' } });

    await expect(provider.handlePush({ ref: 'release' })).resolves.toEqual({ dispatched: 1 });
  });

  it('supports the register/unregister/dispose lifecycle and cancellation', async () => {
    const provider = new GitPushTriggerProvider({});
    await provider.register({ id: 'a', kind: 'webhook' });
    await expect(provider.register({ id: 'a', kind: 'webhook' })).rejects.toThrow(/already registered/);
    await provider.unregister('a');
    await expect(provider.handlePush(push, { signal: abortedSignal() })).rejects.toThrow();
    await provider.dispose();
  });
});

describe('IssueEventTriggerProvider', () => {
  const issue = { action: 'opened', issue: { number: 7, title: 'Bug', labels: ['bug'] } };

  it('dispatches an issue event matching the subscribed action', async () => {
    const onIssue = vi.fn(async () => undefined);
    const provider = new IssueEventTriggerProvider({ onIssue });
    await provider.register({ id: 'opened', kind: 'webhook', payload: { action: 'opened' } });

    const result = await provider.handleIssue(issue);

    expect(result.dispatched).toBe(1);
    expect(onIssue).toHaveBeenCalledWith(expect.objectContaining({ action: 'opened' }), expect.any(Object));
  });

  it('filters by action and by label', async () => {
    const onIssue = vi.fn(async () => undefined);
    const provider = new IssueEventTriggerProvider({ onIssue });
    await provider.register({ id: 'closed', kind: 'webhook', payload: { action: 'closed' } });
    await provider.register({ id: 'labelled', kind: 'webhook', payload: { label: 'bug' } });

    const result = await provider.handleIssue(issue);

    // "closed" does not match; "labelled" (label=bug) matches.
    expect(result.dispatched).toBe(1);
    expect(onIssue).toHaveBeenCalledTimes(1);
  });

  it('supports the register/unregister/dispose lifecycle and duplicate protection', async () => {
    const provider = new IssueEventTriggerProvider({});
    await provider.register({ id: 'x', kind: 'webhook' });
    await expect(provider.register({ id: 'x', kind: 'webhook' })).rejects.toThrow(/already registered/);
    await provider.unregister('x');
    await provider.dispose();
    await expect(provider.unregister('x')).rejects.toThrow(/Unknown trigger/);
  });
});

describe('ScheduleTriggerProvider', () => {
  function fakeTimers() {
    const armed: Array<{ handle: number; callback: () => void; ms: number }> = [];
    const cleared: unknown[] = [];
    let next = 0;
    const setInterval = (callback: () => void, ms: number) => {
      const handle = ++next;
      armed.push({ handle, callback, ms });
      return handle;
    };
    const clearInterval = (handle: unknown) => {
      cleared.push(handle);
    };
    return { setInterval, clearInterval, armed, cleared };
  }

  it('arms an interval timer using the descriptor schedule as milliseconds', async () => {
    const timers = fakeTimers();
    const onFire = vi.fn(async () => undefined);
    const provider = new ScheduleTriggerProvider({ onFire, setInterval: timers.setInterval, clearInterval: timers.clearInterval });

    await provider.register({ id: 'tick', kind: 'schedule', schedule: '250' });

    expect(timers.armed).toHaveLength(1);
    expect(timers.armed[0].ms).toBe(250);
    expect(provider.armedTimerIds).toEqual(['tick']);

    // Simulate a tick: the registered callback actually fires the handler.
    timers.armed[0].callback();
    expect(onFire).toHaveBeenCalledTimes(1);
    expect(onFire).toHaveBeenCalledWith(expect.objectContaining({ id: 'tick' }));
  });

  it('clears the timer on unregister', async () => {
    const timers = fakeTimers();
    const provider = new ScheduleTriggerProvider({ setInterval: timers.setInterval, clearInterval: timers.clearInterval });
    await provider.register({ id: 'tick', kind: 'schedule', schedule: '1000' });

    await provider.unregister('tick');

    expect(timers.cleared).toEqual([timers.armed[0].handle]);
    expect(provider.armedTimerIds).toEqual([]);
  });

  it('clears every timer on dispose', async () => {
    const timers = fakeTimers();
    const provider = new ScheduleTriggerProvider({ setInterval: timers.setInterval, clearInterval: timers.clearInterval });
    await provider.register({ id: 'a', kind: 'schedule', schedule: '100' });
    await provider.register({ id: 'b', kind: 'schedule', schedule: '200' });

    await provider.dispose();

    expect(timers.cleared).toHaveLength(2);
    expect(provider.armedTimerIds).toEqual([]);
  });

  it('rejects duplicate ids and unknown unregistration', async () => {
    const timers = fakeTimers();
    const provider = new ScheduleTriggerProvider({ setInterval: timers.setInterval, clearInterval: timers.clearInterval });
    await provider.register({ id: 'a', kind: 'schedule', schedule: '100' });

    await expect(provider.register({ id: 'a', kind: 'schedule', schedule: '100' })).rejects.toThrow(/already registered/);
    await expect(provider.unregister('missing')).rejects.toThrow(/Unknown trigger/);
  });

  it.each(['0', '-100', '1.5', 'abc', '', '   '])('rejects invalid schedule %j', async schedule => {
    const timers = fakeTimers();
    const provider = new ScheduleTriggerProvider({ setInterval: timers.setInterval, clearInterval: timers.clearInterval });

    await expect(provider.register({ id: 'bad', kind: 'schedule', schedule })).rejects.toThrow(/Invalid schedule/);
    expect(timers.armed).toHaveLength(0);
  });

  it('rejects a missing schedule', async () => {
    const timers = fakeTimers();
    const provider = new ScheduleTriggerProvider({ setInterval: timers.setInterval, clearInterval: timers.clearInterval });

    await expect(provider.register({ id: 'bad', kind: 'schedule' })).rejects.toThrow(/Invalid schedule/);
    expect(timers.armed).toHaveLength(0);
  });

  it('rejects a descriptor whose kind is not schedule', async () => {
    const timers = fakeTimers();
    const provider = new ScheduleTriggerProvider({ setInterval: timers.setInterval, clearInterval: timers.clearInterval });

    await expect(provider.register({ id: 'w', kind: 'webhook' })).rejects.toThrow(/schedule/);
    expect(timers.armed).toHaveLength(0);
  });

  it('respects cancellation during registration', async () => {
    const timers = fakeTimers();
    const provider = new ScheduleTriggerProvider({ setInterval: timers.setInterval, clearInterval: timers.clearInterval });

    await expect(
      provider.register({ id: 'a', kind: 'schedule', schedule: '100' }, { signal: abortedSignal() }),
    ).rejects.toThrow();
    expect(timers.armed).toHaveLength(0);
  });
});

describe('trigger descriptor typing', () => {
  it('accepts a schedule descriptor with an integer millisecond value', () => {
    const descriptor: TriggerDescriptor = { id: 'd', kind: 'schedule', schedule: '1500' };
    expect(descriptor.schedule).toBe('1500');
  });
});

describe('trigger JSON configuration payloads', () => {
  const descriptor = (payload: unknown): TriggerDescriptor => ({ id: 'nested', kind: 'schedule', schedule: '100', payload } as TriggerDescriptor);

  it('preserves nested capability.invoke input on a schedule and isolates caller mutation', async () => {
    let tick = () => {};
    const onFire = vi.fn<[TriggerDescriptor], void>();
    const input = { capability: 'notification', operation: 'notify', input: { title: 'Scheduled', details: { tags: ['build', null, true, 3] } } };
    const provider = new ScheduleTriggerProvider({ onFire, setInterval: callback => { tick = callback; return 1; }, clearInterval: vi.fn() });
    await provider.register(descriptor(input));
    input.input.details.tags[0] = 'mutated';
    tick();
    expect(onFire.mock.calls[0][0].payload).toEqual({ capability: 'notification', operation: 'notify', input: { title: 'Scheduled', details: { tags: ['build', null, true, 3] } } });
    await provider.dispose();
  });

  it('accepts repeated references that do not form a cycle', async () => {
    const shared = { values: [null, { enabled: true }] };
    const provider = new ScheduleTriggerProvider({ setInterval: vi.fn(), clearInterval: vi.fn() });
    await provider.register(descriptor({ first: shared, second: shared }));
    await provider.dispose();
  });

  it.each([undefined, NaN, Infinity, 1n, () => {}, Symbol('invalid'), new Date(), new Map()])('rejects a nested non-JSON value %s', async value => {
    const setInterval = vi.fn();
    const provider = new ScheduleTriggerProvider({ setInterval, clearInterval: vi.fn() });
    await expect(provider.register(descriptor({ input: { values: [value] } }))).rejects.toThrow(/Invalid trigger payload/);
    expect(setInterval).not.toHaveBeenCalled();
    await provider.register(descriptor({ input: { valid: true } }));
    await provider.dispose();
  });

  it('rejects cycles without arming timers or retaining registrations', async () => {
    const cyclic: { self?: object } = {};
    cyclic.self = cyclic;
    const provider = new ScheduleTriggerProvider({ setInterval: vi.fn(), clearInterval: vi.fn() });
    await expect(provider.register(descriptor({ input: cyclic }))).rejects.toThrow(/Invalid trigger payload/);
    await provider.register(descriptor({ input: null }));
    await provider.dispose();
  });

  it('only reads string filters at known keys when payloads contain JSON objects', async () => {
    const push = new GitPushTriggerProvider({ onPush: vi.fn() });
    const issue = new IssueEventTriggerProvider({ onIssue: vi.fn() });
    const webhook = new WebhookTriggerProvider({ secret: 'secret', onEvent: vi.fn() });
    const registration = { ...descriptor({ branch: { value: 'main' }, action: { value: 'closed' }, label: ['bug'], event: { value: 'other' } }), kind: 'webhook' as const };
    for (const provider of [push, issue, webhook]) await provider.register(registration);
    expect(await push.handle({ ref: 'feature' })).toEqual({ dispatched: 1 });
    expect(await issue.handle({ action: 'opened', issue: { labels: [] } })).toEqual({ dispatched: 1 });
    const raw = '{"event":"push","payload":{}}';
    expect(await webhook.handle(raw, sign('secret', raw))).toEqual({ dispatched: 1 });
  });
});

describe('trigger failure boundaries', () => {
  const descriptor: TriggerDescriptor = { id: 'tick', kind: 'schedule', schedule: '100' };
  const flush = () => new Promise<void>(resolve => setImmediate(resolve));

  it.each([null, [], 42, 'push', { payload: null }, { payload: [] }, { event: 42 }, { type: '' }])('rejects signed non-object or malformed webhook payload %j', async payload => {
    const onEvent = vi.fn();
    const provider = new WebhookTriggerProvider({ secret: 'secret', onEvent });
    await provider.register({ id: 'event', kind: 'webhook' });
    const raw = JSON.stringify(payload);
    await expect(provider.handle(raw, sign('secret', raw))).rejects.toThrow(/payload|event/i);
    expect(onEvent).not.toHaveBeenCalled();
  });

  it('rolls registration back when activation throws and permits retry', async () => {
    const setInterval = vi.fn().mockImplementationOnce(() => { throw new Error('timer unavailable'); }).mockReturnValue(1);
    const provider = new ScheduleTriggerProvider({ setInterval, clearInterval: vi.fn() });
    await expect(provider.register(descriptor)).rejects.toThrow('timer unavailable');
    expect(provider.armedTimerIds).toEqual([]);
    await provider.register(descriptor);
    expect(provider.armedTimerIds).toEqual(['tick']);
    await provider.dispose();
  });

  it('rolls back mappings even if activation cleanup also fails', async () => {
    class BrokenSchedule extends ScheduleTriggerProvider {
      protected activate(): void { throw new Error('activate failed'); }
      protected deactivate(): void { throw new Error('cleanup failed'); }
    }
    const provider = new BrokenSchedule();
    await expect(provider.register(descriptor)).rejects.toBeInstanceOf(AggregateError);
    await expect(provider.unregister('tick')).rejects.toThrow(/Unknown trigger/);
    await expect(provider.register(descriptor)).rejects.toThrow(/activation and cleanup/);
  });

  it.each(['sync', 'async', 'error-handler'])('catches %s scheduled callback failures and exposes degraded health', async mode => {
    let tick = () => {};
    const onFire = vi.fn((): void | Promise<void> => {
      if (mode === 'sync') throw new Error('sync callback failed');
      return Promise.reject(new Error('async callback failed'));
    });
    const onError = vi.fn(async () => { if (mode === 'error-handler') throw new Error('reporting failed'); });
    const provider = new ScheduleTriggerProvider({ onFire, onError, setInterval: callback => { tick = callback; return 1; }, clearInterval: vi.fn() });
    await provider.register(descriptor);
    tick();
    await flush();
    expect(onError).toHaveBeenCalledWith(expect.any(Error), expect.objectContaining({ id: 'tick' }));
    expect((await provider.health()).status).toBe('degraded');
    onFire.mockImplementationOnce(() => Promise.resolve());
    tick();
    await flush();
    expect((await provider.health()).status).toBe('ok');
    await provider.dispose();
  });

  it('drains scheduled actions before disposing the provider', async () => {
    let tick: () => void = () => {};
    let finish: () => void = () => {};
    const pending = new Promise<void>(resolve => { finish = resolve; });
    const provider = new ScheduleTriggerProvider({ onFire: () => pending, setInterval: callback => { tick = callback; }, clearInterval: vi.fn() });
    await provider.register({ id: 'interval', kind: 'schedule', schedule: '1000' });
    tick();
    let closed = false;
    const stopping = provider.dispose().then(() => { closed = true; });
    try {
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(closed).toBe(false);
    } finally { finish(); await stopping; }
    expect(closed).toBe(true);
  });

  it('contains rejected schedule promises even without an error callback', async () => {
    let tick = () => {};
    const provider = new ScheduleTriggerProvider({ onFire: async () => { throw new Error('rejected'); }, setInterval: callback => { tick = callback; }, clearInterval: vi.fn() });
    await provider.register(descriptor);
    tick();
    await flush();
    expect((await provider.health()).status).toBe('degraded');
    await provider.dispose();
  });

  it('continues disposal after a timer cleanup failure and retains failures for retry', async () => {
    let next = 0;
    const clearInterval = vi.fn().mockImplementationOnce(() => { throw new Error('clear failed'); });
    const provider = new ScheduleTriggerProvider({ setInterval: () => ++next, clearInterval });
    await provider.register(descriptor);
    await provider.register({ ...descriptor, id: 'other' });
    await expect(provider.dispose()).rejects.toBeInstanceOf(AggregateError);
    expect(clearInterval).toHaveBeenCalledTimes(2);
    expect(provider.armedTimerIds).toEqual(['tick']);
    await provider.dispose();
    expect(provider.armedTimerIds).toEqual([]);
  });

  it('cleans up undefined handles and ignores stale callbacks after unregister', async () => {
    let tick = () => {};
    const onFire = vi.fn();
    const clearInterval = vi.fn();
    const provider = new ScheduleTriggerProvider({ onFire, setInterval: callback => { tick = callback; }, clearInterval });
    await provider.register(descriptor);
    await provider.unregister('tick');
    tick();
    await flush();
    expect(clearInterval).toHaveBeenCalledWith(undefined);
    expect(onFire).not.toHaveBeenCalled();
  });

  it.each(['2147483648', '1e3', '0x100', 'Infinity'])('rejects timer-overflow or non-decimal schedule %s', async schedule => {
    const setInterval = vi.fn();
    const provider = new ScheduleTriggerProvider({ setInterval });
    await expect(provider.register({ ...descriptor, schedule })).rejects.toThrow(/Invalid schedule/);
    expect(setInterval).not.toHaveBeenCalled();
  });

  it('copies registered descriptors to prevent caller mutation changing filters or cleanup', async () => {
    const onPush = vi.fn();
    const provider = new GitPushTriggerProvider({ onPush });
    const registration = { id: 'main', kind: 'webhook' as const, payload: { branch: 'main' } };
    await provider.register(registration);
    registration.id = 'changed';
    registration.payload.branch = 'changed';
    expect(await provider.handle({ ref: 'refs/heads/main' })).toEqual({ dispatched: 1 });
    await provider.unregister('main');
  });

  it.each([null, [], {}, { ref: '' }, { ref: 'main', deleted: 'false' }, { ref: 'main', repository: [] }])('validates public git push handle input %j', async payload => {
    const provider = new GitPushTriggerProvider({ onPush: vi.fn() });
    await provider.register({ id: 'push', kind: 'webhook' });
    await expect(provider.handle(payload)).rejects.toThrow(/payload/);
  });

  it.each([null, [], {}, { action: '' }, { action: 'opened', issue: [] }, { action: 'opened', issue: { labels: [42] } }])('validates public issue handle input %j', async payload => {
    const provider = new IssueEventTriggerProvider({ onIssue: vi.fn() });
    await provider.register({ id: 'issue', kind: 'webhook' });
    await expect(provider.handle(payload)).rejects.toThrow(/payload|labels/);
  });

  it('accepts standard issue label objects through the public handle API', async () => {
    const onIssue = vi.fn();
    const provider = new IssueEventTriggerProvider({ onIssue });
    await provider.register({ id: 'bug', kind: 'webhook', payload: { label: 'bug' } });
    expect(await provider.handle({ action: 'opened', issue: { labels: [{ name: 'bug' }] } })).toEqual({ dispatched: 1 });
    expect(onIssue).toHaveBeenCalledOnce();
  });

  it('propagates awaited handler failures for host error handling', async () => {
    const fail = async () => { throw new Error('handler failed'); };
    const push = new GitPushTriggerProvider({ onPush: fail });
    const issue = new IssueEventTriggerProvider({ onIssue: fail });
    const webhook = new WebhookTriggerProvider({ secret: 'secret', onEvent: fail });
    for (const provider of [push, issue, webhook]) await provider.register({ id: 't', kind: 'webhook' });
    await expect(push.handle({ ref: 'main' })).rejects.toThrow('handler failed');
    await expect(issue.handle({ action: 'opened' })).rejects.toThrow('handler failed');
    await expect(webhook.handle('{}', sign('secret', '{}'))).rejects.toThrow('handler failed');
  });

  it('stops dispatch when cancellation occurs inside a callback', async () => {
    const controller = new AbortController();
    const onPush = vi.fn(async () => { controller.abort(new Error('cancel dispatch')); });
    const provider = new GitPushTriggerProvider({ onPush });
    await provider.register({ id: 'first', kind: 'webhook' });
    await provider.register({ id: 'second', kind: 'webhook' });
    await expect(provider.handle({ ref: 'main' }, { signal: controller.signal })).rejects.toThrow('cancel dispatch');
    expect(onPush).toHaveBeenCalledOnce();
  });

  it('does not claim dispatch when no callback is configured', async () => {
    const push = new GitPushTriggerProvider({});
    const issue = new IssueEventTriggerProvider({});
    const webhook = new WebhookTriggerProvider({ secret: 'secret' });
    for (const provider of [push, issue, webhook]) await provider.register({ id: 't', kind: 'webhook' });
    expect(await push.handle({ ref: 'main' })).toEqual({ dispatched: 0 });
    expect(await issue.handle({ action: 'opened' })).toEqual({ dispatched: 0 });
    expect(await webhook.handle('{}', sign('secret', '{}'))).toEqual({ dispatched: 0 });
  });
});
