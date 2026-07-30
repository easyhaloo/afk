/**
 * Navigation Policy - Declarative mapping from actions to view transitions
 * Part of the reactive data flow for automatic navigation
 */
import { ViewRegistry } from '../registry';
import type { View, ViewState } from '../types';

export type ActionType =
  | 'issue:create-task'
  | 'issue:launch'
  | 'batch:create'
  | 'project:view-issues'
  | 'navigate:back'
  | 'navigate:reset';

export interface NavigationPolicyEntry {
  target: View | 'back';
  context?: (action: ActionType, prevState: ViewState, result?: any) => ViewState['context'];
}

/**
 * Navigation policy defines where to go after an action completes.
 * This is declarative - we define WHAT happens, not HOW to navigate.
 */
export const navigationPolicy: Record<ActionType, NavigationPolicyEntry> = {
  'issue:create-task': {
    target: 'tasks',
    context: () => ({}),
  },
  'issue:launch': {
    target: 'tasks',
    context: () => ({}),
  },
  'batch:create': {
    target: 'tasks',
    context: () => ({}),
  },
  'project:view-issues': {
    target: 'issues',
    context: (action, prevState) => ({
      project: prevState.context?.project,
    }),
  },
  'navigate:back': {
    target: 'back', // Special: means pop from stack
    context: () => ({}),
  },
  'navigate:reset': {
    target: 'tasks',
    context: () => ({}),
  },
};
