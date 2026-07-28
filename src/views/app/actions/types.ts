/**
 * Action types for the app
 */

export type ActionType =
  | 'dispatch'
  | 'issue:create-task'
  | 'issue:launch'
  | 'batch:create'
  | 'project:view-issues'
  | 'navigate:back'
  | 'navigate:reset'
  | 'navigate:switch'
  | 'navigate:goto-detail'
  | 'navigate:goto-list'
  | 'multi-select:toggle'
  | 'multi-select:toggle-item'
  | 'multi-select:clear'
  | 'search:enable'
  | 'search:disable'
  | 'search:set-query'
  | 'help:toggle'
  | 'debug:toggle'
  | 'debug:log'
  | 'notification:show'
  | 'notification:hide'
  | 'notification:dismiss'
  | 'selection:set'
  | 'selection:down'
  | 'selection:up'
  | 'selection:top'
  | 'selection:bottom'
  | 'separator:tick';

export interface AppAction {
  type: ActionType;
  payload?: any;
}
