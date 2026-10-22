export interface StatsProvider {
  provide(): Record<string, number | string>;
}

export interface StatsAPI {
  register(provider: StatsProvider, id: string): void;
  unregister(id: string): void;
  getAll(): Record<string, number | string>;
}
