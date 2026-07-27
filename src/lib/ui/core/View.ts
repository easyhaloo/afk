/**
 * View Protocol
 *
 * Any panel in the TUI must implement this interface.
 * Views are registered with the Registry and rendered by the PanelHost.
 */
import type { View as ViewType, ViewContext } from './types.js';

export type { View, ViewContext } from './types.js';
export type { ViewMode } from './types.js';
export type { KeyboardEvent } from './types.js';
export type { StatsProvider, StatsAPI } from './types.js';
export type { RegistryAPI } from './types.js';
export type { KeyboardAPI } from './types.js';
