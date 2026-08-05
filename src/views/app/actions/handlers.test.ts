import { describe, expect, it, vi } from 'vitest';
import { openBacklogUrl, createActions } from './handlers';
import type { StateContextValue } from '../state/StateContext';
import type { AppState } from '../state/initialState';

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

describe('search action creators', () => {
  const createMockCtx = (overrides: Partial<AppState> = {}): StateContextValue => {
    const state: AppState = {
      viewStack: [{ view: 'tasks', context: {} }],
      detailView: 'list',
      selectedIndex: 0,
      scrollOffset: 0,
      isSearchMode: false,
      searchQuery: '',
      showHelp: false,
      debugMode: false,
      notification: null,
      notifAnimation: 'hidden',
      separatorPhase: 0,
      debugLog: [],
      ...overrides,
    };
    const dispatch = vi.fn();
    return { state, dispatch, currentView: 'tasks', currentContext: {}, isDetailMode: false };
  };

  it('enableSearch dispatches search:enable and selection:top', () => {
    const ctx = createMockCtx();
    const actions = createActions(ctx);
    actions.enableSearch();
    expect(ctx.dispatch).toHaveBeenCalledWith({ type: 'search:enable' });
    expect(ctx.dispatch).toHaveBeenCalledWith({ type: 'selection:top' });
  });

  it('disableSearch dispatches search:disable', () => {
    const ctx = createMockCtx({ isSearchMode: true, searchQuery: 'test' });
    const actions = createActions(ctx);
    actions.disableSearch();
    expect(ctx.dispatch).toHaveBeenCalledWith({ type: 'search:disable' });
  });

  it('appendSearchChar appends character to searchQuery', () => {
    const ctx = createMockCtx({ isSearchMode: true, searchQuery: 'te' });
    const actions = createActions(ctx);
    actions.appendSearchChar('s');
    expect(ctx.dispatch).toHaveBeenCalledWith({ type: 'search:set-query', payload: { query: 'tes' } });
  });

  it('backspaceSearch removes last character from searchQuery', () => {
    const ctx = createMockCtx({ isSearchMode: true, searchQuery: 'test' });
    const actions = createActions(ctx);
    actions.backspaceSearch();
    expect(ctx.dispatch).toHaveBeenCalledWith({ type: 'search:set-query', payload: { query: 'tes' } });
  });

  it('backspaceSearch on empty query dispatches empty query (no-op)', () => {
    const ctx = createMockCtx({ isSearchMode: true, searchQuery: '' });
    const actions = createActions(ctx);
    actions.backspaceSearch();
    // slice(0, -1) on empty string returns '', so it dispatches empty query (reducer no-op)
    expect(ctx.dispatch).toHaveBeenCalledWith({ type: 'search:set-query', payload: { query: '' } });
  });
});
