import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { createDefaultPluginRuntime } from './default-runtime.js';
import { PluginRuntime } from './runtime.js';
import { DurableTriggerQueue, currentTriggerDeliveryId, TriggerDeliveryConflict } from './trigger-queue.js';
import { pluginTriggerQueue } from './listener.js';
import { executeWorkItem } from '../workflows/execute-work-item.js';
import { openSqlite } from '../../infrastructure/storage/sqlite.js';

vi.mock('../workflows/execute-work-item.js', () => ({ executeWorkItem: vi.fn() }));

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function fixture() {
  const homeDir = mkdtempSync(join(tmpdir(), 'afk-schedule-delivery-'));
  cleanup.push(() => rmSync(homeDir, { recursive: true, force: true }));
  mkdirSync(join(homeDir, '.afk'));
  const payload = { capability: 'context.provider', provider: 'context.code', operation: 'gather', input: { prompt: 'original', scope: '.' } };
  writeFileSync(join(homeDir, '.afk', 'plugins.yml'), JSON.stringify({ plugins: [{ id: 'trigger.schedule', builtin: true, action: 'capability.invoke', config: { triggers: [{ id: 'tick', kind: 'schedule', schedule: '1000', payload }] } }] }));
  return { homeDir, payload, file: join(homeDir, '.afk', 'triggers', 'deliveries.sqlite') };
}

it('persists the first activation tick before any listener exists and dispatches under its durable identity', async () => {
  vi.useFakeTimers();
  const { homeDir, file, payload } = fixture();
  vi.spyOn(globalThis, 'setInterval').mockImplementation(callback => {
    (callback as () => void)();
    return { unref() {} } as ReturnType<typeof setInterval>;
  });
  const ids: Array<string | undefined> = [];
  const dispatch = vi.spyOn(PluginRuntime.prototype, 'dispatchSystemAction').mockImplementation(async () => { ids.push(currentTriggerDeliveryId()); });
  const runtime = await createDefaultPluginRuntime({ homeDir, workspaceRoot: homeDir, activateTriggers: true });
  cleanup.push(() => runtime.dispose());
  expect(existsSync(file)).toBe(true);
  const database = openSqlite({ file, schema: '', version: 2 });
  cleanup.push(() => database.close());
  const row = database.prepare('SELECT deliveryId, providerId, body, status FROM trigger_deliveries').get()!;
  expect(row).toMatchObject({ providerId: 'trigger.schedule', status: 'pending' });
  expect(JSON.parse(String(row.body))).toMatchObject({ action: 'capability.invoke', input: payload, triggerId: 'tick' });
  expect(dispatch).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(ids).toEqual([row.deliveryId]);
  expect(database.prepare('SELECT status FROM trigger_deliveries').get()?.status).toBe('delivered');
  expect(currentTriggerDeliveryId()).toBeUndefined();
});

it.each([false, true])('reports failed scheduled actions and retains a retryable delivery when the warning sink throws: %s', async throws => {
  vi.useFakeTimers();
  const ticks = captureTicks();
  const { homeDir } = fixture();
  const warn = vi.fn(() => { if (throws) throw new Error('warning sink failed'); });
  vi.spyOn(PluginRuntime.prototype, 'dispatchSystemAction').mockRejectedValue(new Error('private action failure'));
  const runtime = await createDefaultPluginRuntime({ homeDir, workspaceRoot: homeDir, activateTriggers: true, warn });
  cleanup.push(() => runtime.dispose());
  ticks[0]();
  await vi.advanceTimersByTimeAsync(1);
  expect(pluginTriggerQueue(runtime)!.status()[0]).toMatchObject({ status: 'pending', attempts: 1 });
  expect(warn).toHaveBeenCalledWith('Trigger action failed for trigger.schedule');
  expect(JSON.stringify(warn.mock.calls)).not.toContain('private action failure');
  expect(await runtime.diagnostics()).toEqual(expect.arrayContaining([
    expect.objectContaining({ pluginId: 'trigger.schedule', code: 'trigger.action-failed', severity: 'error' }),
  ]));
});

it('reserves unique queue ownership before arming any schedule', async () => {
  const { homeDir, file } = fixture();
  const owner = new DurableTriggerQueue(file, async () => {});
  cleanup.push(() => owner.close({ drain: false }));
  const timer = vi.spyOn(globalThis, 'setInterval');
  await expect(createDefaultPluginRuntime({ homeDir, workspaceRoot: homeDir, activateTriggers: true })).rejects.toThrow('already owned');
  expect(timer).not.toHaveBeenCalled();
});

it('releases bootstrap ownership even when the configurable builtin action plugin is disabled', async () => {
  const { homeDir, file } = fixture();
  writeFileSync(join(homeDir, '.afk', 'plugins.yml'), JSON.stringify({ plugins: [{ id: 'workflow.capabilities', builtin: true, enabled: false }] }));
  const runtime = await createDefaultPluginRuntime({ homeDir, workspaceRoot: homeDir, activateTriggers: true });
  cleanup.push(() => runtime.dispose());
  const queue = pluginTriggerQueue(runtime)!;
  cleanup.push(() => queue.close({ drain: false }));
  await runtime.dispose();
  expect(pluginTriggerQueue(runtime)).toBeUndefined();
  const next = new DurableTriggerQueue(file, async () => {});
  await next.close();
});

function captureTicks() {
  const ticks: Array<() => void> = [];
  vi.spyOn(globalThis, 'setInterval').mockImplementation(callback => {
    ticks.push(callback as () => void);
    return { unref() {} } as ReturnType<typeof setInterval>;
  });
  return ticks;
}

it('deduplicates a tick and rejects another body under the same identity', async () => {
  vi.useFakeTimers();
  const ticks = captureTicks();
  const { homeDir, file } = fixture();
  const dispatch = vi.spyOn(PluginRuntime.prototype, 'dispatchSystemAction').mockResolvedValue(undefined);
  const runtime = await createDefaultPluginRuntime({ homeDir, workspaceRoot: homeDir, activateTriggers: true });
  cleanup.push(() => runtime.dispose());
  ticks[0]();
  const database = openSqlite({ file, schema: '', version: 2 });
  cleanup.push(() => database.close());
  const row = database.prepare('SELECT body FROM trigger_deliveries').get()!;
  const body = String(row.body);
  const tick = JSON.parse(body).tick;
  const queue = pluginTriggerQueue(runtime)!;
  expect(queue.enqueue('trigger.schedule', body, tick.id)).toMatchObject({ duplicate: true });
  expect(() => queue.enqueue('trigger.schedule', JSON.stringify({ ...JSON.parse(body), input: {} }), tick.id)).toThrow(TriggerDeliveryConflict);
  await vi.advanceTimersByTimeAsync(1);
  expect(dispatch).toHaveBeenCalledOnce();
  expect(queue.enqueue('trigger.schedule', body, tick.id)).toMatchObject({ duplicate: true, status: 'delivered' });
});

it('retries the persisted action and input after restart despite configuration drift', async () => {
  vi.useFakeTimers();
  const ticks = captureTicks();
  const { homeDir, payload } = fixture();
  const dispatch = vi.spyOn(PluginRuntime.prototype, 'dispatchSystemAction').mockRejectedValueOnce(new Error('transient')).mockResolvedValue(undefined);
  const first = await createDefaultPluginRuntime({ homeDir, workspaceRoot: homeDir, activateTriggers: true, queueOptions: { retryDelayMs: 100 } });
  cleanup.push(() => first.dispose());
  ticks[0]();
  const queue = pluginTriggerQueue(first)!;
  await vi.advanceTimersByTimeAsync(1);
  const receipt = queue.status()[0];
  expect(receipt).toMatchObject({ status: 'pending', attempts: 1 });
  await first.dispose();
  writeFileSync(join(homeDir, '.afk', 'plugins.yml'), JSON.stringify({ plugins: [{ id: 'trigger.schedule', builtin: true, action: 'work-item.execute', config: { triggers: [{ id: 'tick', kind: 'schedule', schedule: '2000', input: { workItemId: 'github:changed/repo#99' } }] } }] }));
  await vi.advanceTimersByTimeAsync(100_000);
  const restarted = await createDefaultPluginRuntime({ homeDir, workspaceRoot: homeDir, activateTriggers: true });
  cleanup.push(() => restarted.dispose());
  const recovered = pluginTriggerQueue(restarted)!;
  expect(recovered.status()).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(recovered.status(receipt.deliveryId)[0]).toMatchObject({ status: 'delivered', attempts: 2 });
  expect(dispatch.mock.calls).toEqual([['capability.invoke', payload], ['capability.invoke', payload]]);
  ticks[0]();
  expect(recovered.storageUsage().records).toBe(1);
});

it('derives managed execution idempotency from the actual durable delivery on every failed-action retry', async () => {
  vi.useFakeTimers();
  const ticks = captureTicks();
  const { homeDir } = fixture();
  const workItemId = 'github:acme/api#42';
  writeFileSync(join(homeDir, '.afk', 'plugins.yml'), JSON.stringify({ plugins: [{ id: 'trigger.schedule', builtin: true, action: 'work-item.execute', config: { triggers: [{ id: 'tick', kind: 'schedule', schedule: '1000', input: { workItemId } }] } }] }));
  const execute = vi.mocked(executeWorkItem);
  execute.mockReset();
  execute.mockResolvedValueOnce({ status: 'blocked' } as Awaited<ReturnType<typeof executeWorkItem>>).mockResolvedValue({ status: 'done' } as Awaited<ReturnType<typeof executeWorkItem>>);
  const runtime = await createDefaultPluginRuntime({ homeDir, workspaceRoot: homeDir, activateTriggers: true, queueOptions: { retryDelayMs: 10, maxAttempts: 2 } });
  cleanup.push(() => runtime.dispose());
  ticks[0]();
  const queue = pluginTriggerQueue(runtime)!;
  const receipt = queue.status()[0];
  await vi.advanceTimersByTimeAsync(1);
  expect(queue.status()[0]).toMatchObject({ status: 'pending', attempts: 1 });
  await vi.advanceTimersByTimeAsync(10);
  expect(queue.status()[0]).toMatchObject({ status: 'delivered', attempts: 2 });
  const executionId = createHash('sha256').update(`${receipt.deliveryId}\0${workItemId}`).digest('hex');
  expect(execute).toHaveBeenCalledTimes(2);
  expect(execute.mock.calls.map(call => call[0].executionId)).toEqual([executionId, executionId]);
});

it('reports capacity failure without dispatching an unpersisted tick', async () => {
  vi.useFakeTimers();
  const ticks = captureTicks();
  const { homeDir } = fixture();
  const dispatch = vi.spyOn(PluginRuntime.prototype, 'dispatchSystemAction').mockResolvedValue(undefined);
  const runtime = await createDefaultPluginRuntime({ homeDir, workspaceRoot: homeDir, activateTriggers: true, queueOptions: { maxRecords: 1 } });
  cleanup.push(() => runtime.dispose());
  ticks[0]();
  ticks[0]();
  await vi.advanceTimersByTimeAsync(1);
  expect(pluginTriggerQueue(runtime)!.storageUsage().records).toBe(1);
  expect(dispatch).toHaveBeenCalledOnce();
  expect((await runtime.diagnostics()).some(row => row.code === 'trigger.queue-full')).toBe(true);
  expect((await runtime.getTriggerProvider('trigger.schedule')!.health!()).status).toBe('degraded');
});

it('diagnoses receipt persistence failure without falling back to a direct action', async () => {
  vi.useFakeTimers();
  const ticks = captureTicks();
  const { homeDir, file } = fixture();
  const dispatch = vi.spyOn(PluginRuntime.prototype, 'dispatchSystemAction').mockResolvedValue(undefined);
  const runtime = await createDefaultPluginRuntime({ homeDir, workspaceRoot: homeDir, activateTriggers: true });
  cleanup.push(() => runtime.dispose());
  const database = openSqlite({ file, schema: '', version: 2 });
  cleanup.push(() => database.close());
  database.exec("CREATE TRIGGER reject_receipt BEFORE INSERT ON trigger_deliveries BEGIN SELECT RAISE(ABORT, 'private disk failure'); END");
  ticks[0]();
  await vi.advanceTimersByTimeAsync(1);
  expect(pluginTriggerQueue(runtime)!.status()).toEqual([]);
  expect(dispatch).not.toHaveBeenCalled();
  expect((await runtime.diagnostics()).some(row => row.code === 'trigger.persistence-failed' && !row.message.includes('private disk failure'))).toBe(true);
});

it('bounds runtime disposal while retaining ownership until its uncooperative action confirms completion', async () => {
  vi.useFakeTimers();
  const ticks = captureTicks();
  const { homeDir, file } = fixture();
  let finish!: () => void;
  const action = new Promise<void>(resolve => { finish = resolve; });
  const dispatch = vi.spyOn(PluginRuntime.prototype, 'dispatchSystemAction').mockImplementation(async () => action);
  const runtime = await createDefaultPluginRuntime({ homeDir, workspaceRoot: homeDir, activateTriggers: true });
  cleanup.push(() => runtime.dispose());
  const queue = pluginTriggerQueue(runtime)!;
  ticks[0]();
  ticks[0]();
  await vi.advanceTimersByTimeAsync(1);
  let failure: unknown;
  void runtime.dispose().catch(error => { failure = error; });
  await vi.advanceTimersByTimeAsync(5000);
  try {
    expect(failure).toBeInstanceOf(AggregateError);
    expect(pluginTriggerQueue(runtime)).toBe(queue);
    expect(() => new DurableTriggerQueue(file, async () => {})).toThrow('already owned');
    expect(queue.status().map(row => row.status).sort()).toEqual(['pending', 'processing']);
    ticks[0]();
    expect(dispatch).toHaveBeenCalledOnce();
  } finally { finish(); await queue.close({ drain: false }); }
  expect(pluginTriggerQueue(runtime)).toBeUndefined();
  const next = new DurableTriggerQueue(file, async () => {});
  cleanup.push(() => next.close());
  expect(next.status().map(row => row.status).sort()).toEqual(['delivered', 'pending']);
});
