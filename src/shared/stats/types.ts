export type StatsValue = number | string;
export interface StatsProvider {
  provide(): Record<string, StatsValue>;
}
export interface StatsAPI {
  register(provider: StatsProvider, id: string): void;
  unregister(id: string): void;
  getAll(): Record<string, StatsValue>;
}
