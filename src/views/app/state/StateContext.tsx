/**
 * State Context - provides app state and dispatch
 */
import React, { createContext, useContext, useReducer, useCallback, useRef, useEffect } from 'react';
import type { AppState, ViewState, ViewType, ViewContext } from './initialState';
import { initialState } from './initialState';
import type { AppAction } from '../actions/types';

/**
 * Navigation policy - declarative mapping from action to state changes
 */
const navigationPolicy: Record<string, {
  target?: ViewType | 'back';
  context?: (state: AppState, action: AppAction) => ViewContext;
  setDetailView?: 'list' | 'detail' | null;
}> = {
  'issue:create-task': { target: 'tasks' },
  'issue:launch': { target: 'tasks' },
  'batch:create': { target: 'tasks' },
  'project:view-issues': { target: 'issues', context: (s) => ({ project: s.viewStack[s.viewStack.length - 1]?.context?.project }) },
  'navigate:back': { target: 'back' },
  'navigate:reset': { target: 'tasks' },
  'multi-select:toggle': { setDetailView: null },
  'multi-select:clear': { setDetailView: null },
  'search:disable': { setDetailView: null },
  'search:enable': { setDetailView: null },
};

function reducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case 'dispatch': {
      const nav = navigationPolicy[action.payload?.type];
      if (nav) {
        // Handle view stack changes
        if (nav.target === 'back') {
          if (state.viewStack.length > 1) {
            return {
              ...state,
              viewStack: state.viewStack.slice(0, -1),
              selectedIndex: 0,
              scrollOffset: 0,
            };
          }
        } else if (nav.target) {
          const ctx = nav.context ? nav.context(state, action) : {};
          return {
            ...state,
            viewStack: [...state.viewStack, { view: nav.target, context: ctx }],
            selectedIndex: 0,
            scrollOffset: 0,
          };
        }
        // Handle detail view changes
        if (nav.setDetailView !== undefined) {
          return { ...state, detailView: nav.setDetailView ?? state.detailView };
        }
      }
      return state;
    }

    case 'multi-select:toggle':
      return {
        ...state,
        multiSelectMode: !state.multiSelectMode,
        selectedItems: new Set(),
      };

    case 'multi-select:toggle-item': {
      const id = action.payload?.id;
      if (id === undefined) return state;
      const next = new Set(state.selectedItems);
      next.has(id) ? next.delete(id) : next.add(id);
      return { ...state, selectedItems: next };
    }

    case 'multi-select:clear':
      return { ...state, selectedItems: new Set() };

    case 'search:enable':
      return { ...state, isSearchMode: true, searchQuery: '' };

    case 'search:disable':
      return { ...state, isSearchMode: false, searchQuery: '' };

    case 'search:set-query':
      return { ...state, searchQuery: action.payload?.query ?? '' };

    case 'help:toggle':
      return { ...state, showHelp: !state.showHelp };

    case 'debug:toggle':
      return { ...state, debugMode: !state.debugMode };

    case 'notification:show':
      return {
        ...state,
        notification: action.payload,
        notifAnimation: 'slide-in',
      };

    case 'notification:hide':
      return { ...state, notification: null, notifAnimation: 'hidden' };

    case 'notification:dismiss':
      return { ...state, notifAnimation: 'slide-out' };

    // Navigation
    case 'navigate:switch': {
      const view = action.payload?.view as ViewType;
      if (!view) return state;
      const top = state.viewStack[state.viewStack.length - 1];
      if (top?.view === view) return state;
      return {
        ...state,
        viewStack: [...state.viewStack, { view, context: {} }],
        selectedIndex: 0,
        scrollOffset: 0,
      };
    }

    case 'navigate:goto-detail':
      return { ...state, detailView: 'detail' };

    case 'navigate:goto-list':
      return { ...state, detailView: 'list', selectedIndex: 0 };

    // Selection
    case 'selection:set':
      return { ...state, selectedIndex: action.payload?.index ?? 0 };

    case 'selection:down': {
      const len = action.payload?.length ?? 0;
      return { ...state, selectedIndex: Math.min(state.selectedIndex + 1, len - 1) };
    }

    case 'selection:up':
      return { ...state, selectedIndex: Math.max(state.selectedIndex - 1, 0) };

    case 'selection:top':
      return { ...state, selectedIndex: 0, scrollOffset: 0 };

    case 'selection:bottom': {
      const len = action.payload?.length ?? 0;
      const idx = Math.max(0, len - 1);
      return { ...state, selectedIndex: idx, scrollOffset: Math.max(0, idx) };
    }

    // Animation
    case 'separator:tick':
      return { ...state, separatorPhase: (state.separatorPhase + 1) % 100 };

    // Debug
    case 'debug:log': {
      const msg = action.payload?.message;
      if (!msg) return state;
      return { ...state, debugLog: [...state.debugLog.slice(-20), msg] };
    }

    default:
      return state;
  }
}

export interface StateContextValue {
  state: AppState;
  dispatch: (action: AppAction) => void;
  currentView: ViewType;
  currentContext: ViewContext;
  isDetailMode: boolean;
}

const StateContext = createContext<StateContextValue | null>(null);

export function StateProvider({ children }: { children: React.ReactNode }) {
  const [state, baseDispatch] = useReducer(reducer, initialState);

  const dispatch = useCallback((action: AppAction) => {
    baseDispatch(action);
  }, []);

  const currentView = state.viewStack[state.viewStack.length - 1]?.view ?? 'tasks';
  const currentContext = state.viewStack[state.viewStack.length - 1]?.context ?? {};
  const isDetailMode = state.detailView === 'detail';

  // Animation tick
  useEffect(() => {
    if (isDetailMode) return;
    const t = setInterval(() => dispatch({ type: 'separator:tick' }), 500);
    return () => clearInterval(t);
  }, [isDetailMode]);

  return (
    <StateContext.Provider value={{ state, dispatch, currentView, currentContext, isDetailMode }}>
      {children}
    </StateContext.Provider>
  );
}

export function useState(): StateContextValue {
  const ctx = useContext(StateContext);
  if (!ctx) throw new Error('useState must be used within StateProvider');
  return ctx;
}
