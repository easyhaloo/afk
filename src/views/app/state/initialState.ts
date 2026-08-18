import type { Project } from '../../../domain/tracker/types';

export type ViewType = 'tasks' | 'backlogs' | 'projects' | 'board';
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
  viewStack: ViewState[];
  detailView: DetailMode;
  selectedIndex: number;
  scrollOffset: number;
  isSearchMode: boolean;
  searchQuery: string;
  showHelp: boolean;
  debugMode: boolean;
  notification: Notification | null;
  notifAnimation: 'hidden' | 'slide-in' | 'visible' | 'slide-out';
  separatorPhase: number;
  debugLog: string[];
}

export const initialState: AppState = {
  viewStack: [{ view: 'tasks', context: {} }],
  detailView: 'list',
  selectedIndex: 0,
  scrollOffset: 0,
  isSearchMode: false,
  searchQuery: '',
  showHelp: false,
  debugMode: false,
  notification: null,
  notifAnimation: 'hidden',
  separatorPhase: 0,
  debugLog: [],
};
