import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BacklogItem } from '@afk/application';
import { waitForTerminal } from './codex-runtime-wait';

describe('Codex E2E phase deadlines', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('gives QA its own deadline after implementation consumes most of its budget', async () => {
    let state: BacklogItem['state'] = 'in_progress';
    const get = vi.fn(async () => ({ state, executionMode: 'hitl' } as BacklogItem));
    const result = waitForTerminal({ get }, '177', new Promise(() => {}), 30_000);
    const settled = result.then(value => ({ value }), error => ({ error }));
    await vi.advanceTimersByTimeAsync(15_000);
    state = 'verification';
    await vi.advanceTimersByTimeAsync(20_000);
    state = 'merge_ready';
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await settled).toMatchObject({ value: { state: 'merge_ready' } });
  });

  it.each(['in_progress', 'verification'] as const)('times out a stalled %s phase', async state => {
    const get = vi.fn(async () => ({ state, executionMode: 'afk' } as BacklogItem));
    const result = waitForTerminal({ get }, '177', new Promise(() => {}), 30_000);
    const failed = expect(result).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(30_000);
    await failed;
  });

  it('does not extend the QA deadline when a rework returns to verification', async () => {
    let state: BacklogItem['state'] = 'verification';
    const get = vi.fn(async () => ({ state, executionMode: 'afk' } as BacklogItem));
    const result = waitForTerminal({ get }, '177', new Promise(() => {}), 30_000);
    const failed = expect(result).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(10_000);
    state = 'rework';
    await vi.advanceTimersByTimeAsync(10_000);
    state = 'verification';
    await vi.advanceTimersByTimeAsync(10_000);
    await failed;
  });

  it('reports an early Loop stop after entering QA instead of waiting for its deadline', async () => {
    let state: BacklogItem['state'] = 'in_progress';
    const get = vi.fn(async () => ({ state, executionMode: 'afk' } as BacklogItem));
    let stopLoop!: () => void;
    const loop = new Promise<void>(resolve => { stopLoop = resolve; });
    const result = waitForTerminal({ get }, '177', loop, 30_000);
    const failed = expect(result).rejects.toThrow('loop stopped while backlog was verification');
    await vi.advanceTimersByTimeAsync(5_000);
    state = 'verification';
    await vi.advanceTimersByTimeAsync(10_000);
    stopLoop();
    await vi.advanceTimersByTimeAsync(5_000);
    await failed;
  });

  it.each([new Error('Loop execution failed'), undefined])('propagates the original Loop rejection %s during QA', async reason => {
    let state: BacklogItem['state'] = 'in_progress';
    const get = vi.fn(async () => ({ state, executionMode: 'afk' } as BacklogItem));
    let failLoop!: (error: unknown) => void;
    const loop = new Promise<void>((_resolve, reject) => { failLoop = reject; });
    const result = waitForTerminal({ get }, '177', loop, 30_000);
    const settled = result.then(value => ({ value }), error => ({ error }));
    await vi.advanceTimersByTimeAsync(5_000);
    state = 'verification';
    await vi.advanceTimersByTimeAsync(10_000);
    failLoop(reason);
    await vi.advanceTimersByTimeAsync(25_000);
    expect(await settled).toEqual({ error: reason });
  });

  it.each(['stopped', 'failed'] as const)('returns the blocked terminal item even when Loop has %s', async outcome => {
    let state: BacklogItem['state'] = 'verification';
    const get = vi.fn(async () => ({ state, executionMode: 'hitl' } as BacklogItem));
    let stopLoop!: () => void;
    let failLoop!: (error: unknown) => void;
    const loop = new Promise<void>((resolve, reject) => { stopLoop = resolve; failLoop = reject; });
    const result = waitForTerminal({ get }, '177', loop, 30_000);
    const settled = result.then(value => ({ value }), error => ({ error }));
    await vi.advanceTimersByTimeAsync(15_000);
    state = 'blocked';
    if (outcome === 'stopped') stopLoop();
    else failLoop(new Error('Loop stopped after blocking the backlog'));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await settled).toEqual({ value: { state: 'blocked', executionMode: 'hitl' } });
  });
});
