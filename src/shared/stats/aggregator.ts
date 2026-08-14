import type { StatsProvider, StatsAPI, StatsValue } from './types';

export class StatsAggregator implements StatsAPI {
  private providers = new Map<string, StatsProvider>();
  private merged: Record<string, StatsValue> = {};
  private readonly intervalMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(intervalMs = 60_000) {
    this.intervalMs = intervalMs;
  }

  register(provider: StatsProvider, id: string): void {
    this.providers.set(id, provider);
  }

  unregister(id: string): void {
    this.providers.delete(id);
  }

  getAll(): Record<string, StatsValue> {
    return { ...this.merged };
  }

  start(): void {
    this.tick();
    this.timer = setInterval(() => this.tick(), this.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private tick(): void {
    const result: Record<string, StatsValue> = {};
    for (const [id, provider] of this.providers) {
      const stats = provider.provide();
      for (const [key, value] of Object.entries(stats)) {
        result[`${id}.${key}`] = value;
      }
    }
    this.merged = result;
  }
}
