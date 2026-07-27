import { useState, useCallback } from 'react';
import type { View } from '../types';

export function useNavigation() {
  const [currentView, setCurrentView] = useState<View>('tasks');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [scrollOffset, setScrollOffset] = useState(0);
  const [detailView, setDetailView] = useState<'list' | 'detail'>('list');
  const [viewStack, setViewStack] = useState<View[]>([]);

  const isDetailMode = detailView === 'detail';

  const pushView = useCallback((view: View) => {
    setViewStack(prev => [...prev, currentView]);
    setCurrentView(view);
  }, [currentView]);

  const popView = useCallback(() => {
    if (viewStack.length === 0) return false;
    const prev = viewStack[viewStack.length - 1];
    setViewStack(prev => prev.slice(0, -1));
    setCurrentView(prev);
    setSelectedIndex(0);
    setScrollOffset(0);
    return true;
  }, [viewStack]);

  const canGoBack = useCallback(() => viewStack.length > 0, [viewStack]);

  const switchView = useCallback((view: View) => {
    if (view !== currentView) {
      setViewStack(prev => [...prev, currentView]);
    }
    setCurrentView(view);
  }, [currentView]);

  const navigateDown = useCallback((itemsLength: number) => {
    setSelectedIndex(i => Math.min(i + 1, itemsLength - 1));
  }, []);

  const navigateUp = useCallback(() => {
    setSelectedIndex(i => Math.max(i - 1, 0));
  }, []);

  const navigateTop = useCallback(() => {
    setSelectedIndex(0);
  }, []);

  const navigateBottom = useCallback((itemsLength: number) => {
    setSelectedIndex(Math.max(0, itemsLength - 1));
  }, []);

  const resetOnViewChange = useCallback(() => {
    setSelectedIndex(0);
    setScrollOffset(0);
    setDetailView('list');
  }, []);

  return {
    currentView, setCurrentView,
    selectedIndex, setSelectedIndex,
    scrollOffset, setScrollOffset,
    detailView, setDetailView, isDetailMode,
    viewStack,
    pushView, popView, canGoBack, switchView,
    navigateDown, navigateUp, navigateTop, navigateBottom,
    resetOnViewChange,
  };
}
