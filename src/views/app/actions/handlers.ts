/**
 * Action handlers - business logic for actions
 */
import { exec } from 'child_process';
import type { AppAction } from './types';
import type { StateContextValue } from '../state/StateContext';

export function createActions(ctx: StateContextValue) {
  const { state, dispatch } = ctx;

  const notify = (message: string, type: 'info' | 'success' | 'warning' | 'error' = 'info') => {
    dispatch({ type: 'notification:show', payload: { message, type } });
    setTimeout(() => dispatch({ type: 'notification:dismiss' }), 2700);
    setTimeout(() => dispatch({ type: 'notification:hide' }), 3000);
  };

  return {
    // Navigation
    goBack: () => dispatch({ type: 'dispatch', payload: { type: 'navigate:back' } }),
    switchView: (view: string) => dispatch({ type: 'navigate:switch', payload: { view } }),
    viewIssues: (project?: any) => {
      if (project) {
        dispatch({ type: 'dispatch', payload: { type: 'project:view-issues', project } });
      }
      dispatch({ type: 'navigate:goto-list' });
    },
    viewDetail: () => dispatch({ type: 'navigate:goto-detail' }),
    viewList: () => dispatch({ type: 'navigate:goto-list' }),

    // Multi-select
    toggleMultiSelect: () => {
      notify(state.multiSelectMode ? 'exit multi-select' : 'enter multi-select (Space to select)', 'info');
      dispatch({ type: 'multi-select:toggle' });
    },
    toggleItem: (id: number) => dispatch({ type: 'multi-select:toggle-item', payload: { id } }),
    clearSelection: () => {
      dispatch({ type: 'multi-select:clear' });
      notify('cleared', 'info');
    },

    // Search
    enableSearch: () => {
      dispatch({ type: 'search:enable' });
      dispatch({ type: 'selection:top' });
    },
    disableSearch: () => dispatch({ type: 'search:disable' }),
    setSearchQuery: (query: string) => dispatch({ type: 'search:set-query', payload: { query } }),
    appendSearchChar: (char: string) => dispatch({ type: 'search:set-query', payload: { query: state.searchQuery + char } }),
    backspaceSearch: () => dispatch({ type: 'search:set-query', payload: { query: state.searchQuery.slice(0, -1) } }),

    // UI
    toggleHelp: () => dispatch({ type: 'help:toggle' }),
    toggleDebug: () => dispatch({ type: 'debug:toggle' }),
    notify,

    // Selection
    selectionDown: (length: number) => dispatch({ type: 'selection:down', payload: { length } }),
    selectionUp: () => dispatch({ type: 'selection:up' }),
    selectionTop: () => dispatch({ type: 'selection:top' }),
    selectionBottom: (length: number) => dispatch({ type: 'selection:bottom', payload: { length } }),

    // Debug
    debugLog: (message: string) => dispatch({ type: 'debug:log', payload: { message } }),

    // Platform-specific
    openInBrowser: (url: string, label?: string) => {
      const cmd = process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
      exec(cmd, (err) => {
        if (err) notify('open failed', 'error');
        else notify(`opened ${label ?? url}`, 'success');
      });
    },
  };
}
