import type { StatsProvider, StatsAPI } from '../ui/core/types';

/**
 * StatsAggregator — merges stats from all registered StatsProviders on a timer.
 * Data source priority: disk cache > git history > API.
 */
export class StatsAggregator implements StatsAPI {
  private providers = new Map<string, StatsProvider>();
  private merged: Record<string, number | string> = {};
  private intervalMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(intervalMs = 60_000) {
    this.intervalMs = intervalMs;
  }

  register(p: StatsProvider, id: string): void {
    this.providers.set(id, p);
  }

  unregister(id: string): void {
    this.providers.delete(id);
  }

  getAll(): Record<string, number | string> {
    return { ...this.merged };
  }

  start(): void {
    this.tick(); // immediate first run
    this.timer = setInterval(() => this.tick(), this.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private tick(): void {
    const result: Record<string, number | string> = {};
    for (const [id, provider] of this.providers) {
      const stats = provider.provide();
      for (const [key, value] of Object.entries(stats)) {
        result[`${id}.${key}`] = value;
      }
    }
    this.merged = result;
  }
}
