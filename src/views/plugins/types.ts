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

export function isTuiPlugin(value: unknown): value is TuiPlugin {
  if (!value || typeof value !== 'object') return false;
  const plugin = value as Partial<TuiPlugin>;
  return typeof plugin.id === 'string'
    && plugin.id.trim().length > 0
    && typeof plugin.name === 'string'
    && plugin.name.trim().length > 0
    && Array.isArray(plugin.views)
    && plugin.views.every(view => {
      if (!view || typeof view !== 'object') return false;
      const candidate = view as Partial<TuiPluginView>;
      return typeof candidate.id === 'string'
        && candidate.id.trim().length > 0
        && typeof candidate.title === 'string'
        && candidate.title.trim().length > 0
        && typeof candidate.shortcut === 'string'
        && candidate.shortcut.trim().length > 0
        && typeof candidate.render === 'function';
    });
}

export function isBuiltinView(view: string): view is BuiltinView {
  return view === 'tasks' || view === 'backlogs' || view === 'projects' || view === 'board';
}

export function isTuiViewId(view: string): view is TuiViewId {
  return isBuiltinView(view) || /^plugin:[^:]+:[^:]+$/.test(view);
}
