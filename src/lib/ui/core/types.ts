import React from 'react';

// ─── Keyboard Event ───────────────────────────────────────────────────────────

export interface KeyboardEvent {
  readonly key: string;        // e.g. 'return', 'escape', 'q'
  readonly input: string;      // e.g. 'a', '1', 'o'
  readonly ctrl: boolean;
  readonly shift: boolean;
  readonly meta: boolean;
}

// ─── Stats ───────────────────────────────────────────────────────────────────

export interface StatsProvider {
  provide(): Record<string, number | string>;
}

export interface StatsAPI {
  register(p: StatsProvider): void;
  unregister(id: string): void;
  getAll(): Record<string, number | string>;
}

// ─── Registry ────────────────────────────────────────────────────────────────

export interface RegistryAPI {
  register(view: View): void;
  unregister(id: string): void;
  get(id: string): View | undefined;
  getAll(): View[];
  getActive(): View | undefined;
  setActive(id: string): void;
}

// ─── Keyboard ────────────────────────────────────────────────────────────────

export interface KeyboardAPI {
  dispatch(event: KeyboardEvent): void;
  registerGlobal(key: string, handler: () => void): void;
  setActiveView(id: string): void;
}

// ─── View Context ────────────────────────────────────────────────────────────

export interface ViewContext {
  registry: RegistryAPI;
  keyboard: KeyboardAPI;
  stats: StatsAPI;
}

// ─── View ────────────────────────────────────────────────────────────────────

export interface View {
  readonly id: string;
  readonly name: string;
  readonly shortcut: string;     // key to switch to this view
  readonly priority: number;     // higher = built-in priority over plugins

  onMount?(ctx: ViewContext): void;
  onUnmount?(): void;
  onFocus?(): void;
  onBlur?(): void;

  stats?: StatsProvider;

  render(): React.ReactNode;
}

// ─── View Mode ───────────────────────────────────────────────────────────────

export type ViewMode = 'list' | 'detail';

// ─── Notification ────────────────────────────────────────────────────────────

export type NotificationType = 'info' | 'success' | 'warning' | 'error';

export interface Notification {
  type: NotificationType;
  message: string;
}
