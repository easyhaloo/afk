import type { View, ViewState } from '../types';

export type ActionType =
  | 'project:view-backlogs'
  | 'navigate:back'
  | 'navigate:reset';

export interface NavigationPolicyEntry {
  target: View | 'back';
  context?: (action: ActionType, previousState: ViewState, result?: unknown) => ViewState['context'];
}

export const navigationPolicy: Record<ActionType, NavigationPolicyEntry> = {
  'project:view-backlogs': {
    target: 'backlogs',
    context: (_action, previousState) => ({ project: previousState.context?.project }),
  },
  'navigate:back': { target: 'back', context: () => ({}) },
  'navigate:reset': { target: 'tasks', context: () => ({}) },
};
