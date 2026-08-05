/**
 * View Protocol
 *
 * Any panel in the TUI must implement this interface.
 * Views are registered with the Registry and rendered by the PanelHost.
 */
import type { View as ViewType, ViewContext } from './types';

export type { View, ViewContext } from './types';
export type { ViewMode } from './types';
export type { KeyboardEvent } from './types';
export type { StatsProvider, StatsAPI } from './types';
export type { RegistryAPI } from './types';
export type { KeyboardAPI } from './types';
