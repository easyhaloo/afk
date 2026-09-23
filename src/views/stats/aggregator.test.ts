import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StatsAggregator } from './index';

describe('StatsAggregator', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('collects namespaced provider values immediately and on each interval', () => {
    const aggregator = new StatsAggregator(100);
    let count = 0;
    aggregator.register({ provide: () => ({ count: ++count, status: 'ready' }) }, 'worker');

    aggregator.start();
    expect(aggregator.getAll()).toEqual({ 'worker.count': 1, 'worker.status': 'ready' });
    vi.advanceTimersByTime(100);
    expect(aggregator.getAll()).toEqual({ 'worker.count': 2, 'worker.status': 'ready' });
    aggregator.stop();
  });

  it('replaces registrations with the same id and removes unregistered values on the next tick', () => {
    const aggregator = new StatsAggregator(100);
    aggregator.register({ provide: () => ({ value: 1 }) }, 'worker');
    aggregator.register({ provide: () => ({ value: 2 }) }, 'worker');
    aggregator.start();
    expect(aggregator.getAll()).toEqual({ 'worker.value': 2 });

    aggregator.unregister('worker');
    expect(aggregator.getAll()).toEqual({ 'worker.value': 2 });
    vi.advanceTimersByTime(100);
    expect(aggregator.getAll()).toEqual({});
    aggregator.stop();
  });

  it('returns a snapshot and stops refreshing when stopped', () => {
    const aggregator = new StatsAggregator(100);
    let value = 0;
    aggregator.register({ provide: () => ({ value: ++value }) }, 'worker');
    expect(aggregator.getAll()).toEqual({});
    aggregator.start();

    const snapshot = aggregator.getAll();
    snapshot['worker.value'] = 999;
    expect(aggregator.getAll()).toEqual({ 'worker.value': 1 });
    aggregator.stop();
    vi.advanceTimersByTime(200);
    expect(aggregator.getAll()).toEqual({ 'worker.value': 1 });
  });
});
