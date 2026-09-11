import type { TuiViewId } from '../plugins/types';

export type View = TuiViewId;

export type DetailView = 'list' | 'detail';

export type NotificationType = 'info' | 'success' | 'warning' | 'error';

export interface Notification {
  message: string;
  type: NotificationType;
}

// View context - carries data with a view state
export interface ViewContext {
  project?: import('../../domain/tracker/types').Project;
  scrollOffset?: number;
  selectedIndex?: number;
}

// View state - view name + context
export interface ViewState {
  view: View;
  context: ViewContext;
}
