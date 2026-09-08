import type { ReactNode } from 'react';

export type BuiltinView = 'tasks' | 'backlogs' | 'projects' | 'board';
export type TuiViewId = BuiltinView | `plugin:${string}:${string}`;

export interface TuiPluginContext {
  readonly cwd: string;
  readonly workspace?: string;
  readonly notify: (message: string) => void;
}

export interface TuiPluginView {
  readonly id: string;
  readonly title: string;
  readonly shortcut: string;
  readonly render: (context: TuiPluginContext) => ReactNode;
}

export interface TuiPlugin {
  readonly id: string;
  readonly name: string;
  readonly views: readonly TuiPluginView[];
}

export interface LoadedTuiView {
  readonly id: TuiViewId;
  readonly pluginId: string;
  readonly title: string;
  readonly shortcut: string;
  readonly render: TuiPluginView['render'];
}

function isSafeId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9._-]+$/.test(value);
}

function isShortcut(value: unknown): value is string {
  return typeof value === 'string'
    && value.trim() === value
    && Array.from(value).length === 1
    && !/\s/.test(value);
}

export function isTuiPlugin(value: unknown): value is TuiPlugin {
  if (!value || typeof value !== 'object') return false;
  const plugin = value as Partial<TuiPlugin>;
  return isSafeId(plugin.id)
    && typeof plugin.name === 'string'
    && plugin.name.trim().length > 0
    && Array.isArray(plugin.views)
    && plugin.views.every(view => {
      if (!view || typeof view !== 'object') return false;
      const candidate = view as Partial<TuiPluginView>;
      return isSafeId(candidate.id)
        && typeof candidate.title === 'string'
        && candidate.title.trim().length > 0
        && isShortcut(candidate.shortcut)
        && typeof candidate.render === 'function';
    });
}

export function isBuiltinView(view: string): view is BuiltinView {
  return view === 'tasks' || view === 'backlogs' || view === 'projects' || view === 'board';
}

export function isTuiViewId(view: string): view is TuiViewId {
  return isBuiltinView(view) || /^plugin:[^:]+:[^:]+$/.test(view);
}
