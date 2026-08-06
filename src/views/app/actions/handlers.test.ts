import { describe, expect, it, vi } from 'vitest';
import { openBacklogUrl, createActions } from './handlers';
import { initialState } from '../state/initialState';

describe('openBacklogUrl', () => {
  it('opens only the URL supplied by the backlog provider', async () => {
    const open = vi.fn(async (_url: string) => {});

    await expect(openBacklogUrl({ id: '42', webUrl: 'https://example.test/42' }, open)).resolves.toBe(true);
    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith('https://example.test/42');
  });

  it('does not invoke the opener when a backlog has no provider URL', async () => {
    const open = vi.fn(async (_url: string) => {});

    await expect(openBacklogUrl({ id: '42' }, open)).resolves.toBe(false);
    expect(open).not.toHaveBeenCalled();
  });
});

describe('search actions', () => {
  it('enableSearch sets isSearchMode to true and clears searchQuery', () => {
    const dispatch = vi.fn();
    const state = { ...initialState, isSearchMode: false, searchQuery: 'old query' };
    const actions = createActions({ state, dispatch, currentView: 'tasks', currentContext: {}, isDetailMode: false });

    actions.enableSearch();

    expect(dispatch).toHaveBeenCalledWith({ type: 'search:enable' });
    expect(dispatch).toHaveBeenCalledWith({ type: 'selection:top' });
  });

  it('disableSearch sets isSearchMode to false and clears searchQuery', () => {
    const dispatch = vi.fn();
    const state = { ...initialState, isSearchMode: true, searchQuery: 'test' };
    const actions = createActions({ state, dispatch, currentView: 'tasks', currentContext: {}, isDetailMode: false });

    actions.disableSearch();

    expect(dispatch).toHaveBeenCalledWith({ type: 'search:disable' });
  });

  it('appendSearchChar appends character to searchQuery', () => {
    const dispatch = vi.fn();
    const state = { ...initialState, isSearchMode: true, searchQuery: 'test' };
    const actions = createActions({ state, dispatch, currentView: 'tasks', currentContext: {}, isDetailMode: false });

    actions.appendSearchChar('ing');

    expect(dispatch).toHaveBeenCalledWith({ type: 'search:set-query', payload: { query: 'testing' } });
  });

  it('backspaceSearch removes last character from searchQuery', () => {
    const dispatch = vi.fn();
    const state = { ...initialState, isSearchMode: true, searchQuery: 'test' };
    const actions = createActions({ state, dispatch, currentView: 'tasks', currentContext: {}, isDetailMode: false });

    actions.backspaceSearch();

    expect(dispatch).toHaveBeenCalledWith({ type: 'search:set-query', payload: { query: 'tes' } });
  });
  it('/s keyboard shortcut enters search mode via enableSearch', () => {
    // Simulates the 's' keypress handler in AppContent.tsx
    const dispatch = vi.fn();
    const state = { ...initialState, isSearchMode: false, searchQuery: 'old query', selectedIndex: 5 };
    const actions = createActions({ state, dispatch, currentView: 'tasks', currentContext: {}, isDetailMode: false });

    // User presses 's' to enter search mode
    actions.enableSearch();

    expect(dispatch).toHaveBeenCalledWith({ type: 'search:enable' });
    expect(dispatch).toHaveBeenCalledWith({ type: 'selection:top' });
  });
});
