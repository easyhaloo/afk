export type View = 'tasks' | 'issues' | 'completed' | 'projects' | 'board';
export type DetailView = 'list' | 'detail';

export type NotificationType = 'info' | 'success' | 'warning' | 'error';

export interface Notification {
  message: string;
  type: NotificationType;
}
