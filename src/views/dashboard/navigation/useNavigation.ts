import { useState, useCallback, useEffect, useRef } from 'react';
import { ViewRegistry } from '../registry';
import type { ViewState, ViewContext } from '../types';
import { navigationPolicy, type ActionType } from './policy';

// Default initial view state
const DEFAULT_VIEW_STATE: ViewState = { view: 'tasks', context: {} };

/**
 * Action dispatch result - returned when an action triggers navigation
 */
export interface ActionResult {
  action: ActionType;
  result?: any;
}

export function useNavigation() {
  const [viewStack, setViewStack] = useState<ViewState[]>([DEFAULT_VIEW_STATE]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [scrollOffset, setScrollOffset] = useState(0);
  const [detailView, setDetailView] = useState<'list' | 'detail'>('list');
  const [pendingAction, setPendingAction] = useState<ActionResult | null>(null);

  // Track previous state for context propagation
  const prevStateRef = useRef<ViewState>(DEFAULT_VIEW_STATE);

  // Current view and context from top of stack
  const currentState = viewStack[viewStack.length - 1];
  const currentView = currentState.view;
  const currentContext = currentState.context;
  const isDetailMode = detailView === 'detail';

  // When view changes, update prevStateRef
  useEffect(() => {
    prevStateRef.current = currentState;
  }, [currentState]);

  /**
   * Dispatch an action - this triggers automatic navigation based on policy
   */
  const dispatch = useCallback((action: ActionType, result?: any): void => {
    setPendingAction({ action, result });
  }, []);

  // Process pending action - auto-navigate based on policy
  useEffect(() => {
    if (!pendingAction) return;

    const policy = navigationPolicy[pendingAction.action];
    if (!policy) {
      setPendingAction(null);
      return;
    }

    if (policy.target === 'back') {
      // Pop navigation
      if (viewStack.length > 1) {
        setViewStack(prev => prev.slice(0, -1));
        setSelectedIndex(0);
        setScrollOffset(0);
      }
    } else if (ViewRegistry.getInstance().has(policy.target)) {
      // Push to target view with computed context
      const context = policy.context
        ? policy.context(pendingAction.action, prevStateRef.current, pendingAction.result)
        : {};

      setViewStack(prev => [...prev, { view: policy.target, context }]);
      setSelectedIndex(0);
      setScrollOffset(0);
    }

    setPendingAction(null);
  }, [pendingAction, viewStack.length]);

  /**
   * Push a new view onto the stack with optional context
   */
  const pushView = useCallback((view: string, context: ViewContext = {}): void => {
    if (!ViewRegistry.getInstance().has(view)) {
      console.warn(`View "${view}" is not registered`);
      return;
    }
    setViewStack(prev => [...prev, { view, context }]);
  }, []);

  /**
   * Pop the current view and return to previous one
   */
  const popView = useCallback((): boolean => {
    if (viewStack.length <= 1) return false;
    setViewStack(prev => prev.slice(0, -1));
    setSelectedIndex(0);
    setScrollOffset(0);
    return true;
  }, [viewStack.length]);

  /**
   * Check if back navigation is available
   */
  const canGoBack = useCallback((): boolean => {
    return viewStack.length > 1;
  }, [viewStack.length]);

  /**
   * Navigate to a specific view
   */
  const switchView = useCallback((view: string, context: ViewContext = {}): void => {
    if (!ViewRegistry.getInstance().has(view)) {
      console.warn(`View "${view}" is not registered`);
      return;
    }
    if (view !== currentView) {
      setViewStack(prev => [...prev, { view, context }]);
    }
  }, [currentView]);

  /**
   * Reset navigation state to initial view
   */
  const resetNavigation = useCallback((): void => {
    setViewStack([DEFAULT_VIEW_STATE]);
    setSelectedIndex(0);
    setScrollOffset(0);
    setDetailView('list');
  }, []);

  // Navigation helpers
  const navigateDown = useCallback((itemsLength: number) => {
    setSelectedIndex(i => Math.min(i + 1, itemsLength - 1));
  }, []);

  const navigateUp = useCallback(() => {
    setSelectedIndex(i => Math.max(i - 1, 0));
  }, []);

  const navigateTop = useCallback(() => {
    setSelectedIndex(0);
    setScrollOffset(0);
  }, []);

  const navigateBottom = useCallback((itemsLength: number) => {
    const target = Math.max(0, itemsLength - 1);
    setSelectedIndex(target);
    setScrollOffset(Math.max(0, target));
  }, []);

  return {
    // Current state
    currentView,
    currentContext,
    viewStack,
    // Detail mode
    detailView,
    setDetailView,
    isDetailMode,
    // Selection
    selectedIndex,
    setSelectedIndex,
    scrollOffset,
    setScrollOffset,
    // Navigation actions
    dispatch,
    pushView,
    popView,
    canGoBack,
    switchView,
    resetNavigation,
    // Navigation helpers
    navigateDown,
    navigateUp,
    navigateTop,
    navigateBottom,
  };
}
