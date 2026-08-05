export type ActionType =
  | 'dispatch'
  | 'project:view-backlogs'
  | 'navigate:back'
  | 'navigate:reset'
  | 'navigate:switch'
  | 'navigate:goto-detail'
  | 'navigate:goto-list'
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
  | 'selection:move'
  | 'selection:down'
  | 'selection:up'
  | 'selection:top'
  | 'selection:bottom'
  | 'separator:tick';

export interface AppAction {
  type: ActionType;
  payload?: any;
}
