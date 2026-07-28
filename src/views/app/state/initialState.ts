/**
 * Initial state for the app
 */
import type { Project } from '../../../lib/core/tracker/types';

export type ViewType = 'tasks' | 'issues' | 'completed' | 'projects' | 'board';
export type DetailMode = 'list' | 'detail';
export type NotificationType = 'info' | 'success' | 'warning' | 'error';

export interface ViewContext {
  project?: Project;
  scrollOffset?: number;
  selectedIndex?: number;
}

export interface ViewState {
  view: ViewType;
  context: ViewContext;
}

export interface Notification {
  message: string;
  type: NotificationType;
}

export interface AppState {
  // Navigation
  viewStack: ViewState[];
  detailView: DetailMode;
  selectedIndex: number;
  scrollOffset: number;

  // UI modes
  multiSelectMode: boolean;
  selectedItems: Set<number>;
  isSearchMode: boolean;
  searchQuery: string;
  showHelp: boolean;
  debugMode: boolean;

  // Notifications
  notification: Notification | null;
  notifAnimation: 'hidden' | 'slide-in' | 'visible' | 'slide-out';

  // Animation
  separatorPhase: number;

  // Debug
  debugLog: string[];
}

export const initialState: AppState = {
  viewStack: [{ view: 'tasks', context: {} }],
  detailView: 'list',
  selectedIndex: 0,
  scrollOffset: 0,

  multiSelectMode: false,
  selectedItems: new Set(),
  isSearchMode: false,
  searchQuery: '',
  showHelp: false,
  debugMode: false,

  notification: null,
  notifAnimation: 'hidden',

  separatorPhase: 0,

  debugLog: [],
};
