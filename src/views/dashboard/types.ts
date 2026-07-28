// Legacy type alias for backward compatibility
export type View = 'tasks' | 'issues' | 'completed' | 'projects' | 'board';
export type DetailView = 'list' | 'detail';

export type NotificationType = 'info' | 'success' | 'warning' | 'error';

export interface Notification {
  message: string;
  type: NotificationType;
}

// View context - carries data with a view state
export interface ViewContext {
  project?: import('../../lib/core/tracker/types').Project;
  scrollOffset?: number;
  selectedIndex?: number;
}

// View state - view name + context
export interface ViewState {
  view: string;
  context: ViewContext;
}
