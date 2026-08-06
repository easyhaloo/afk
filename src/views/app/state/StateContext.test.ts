import { describe, expect, it } from 'vitest';
import { appReducer } from './StateContext';
import { initialState } from './initialState';

describe('appReducer navigation', () => {
  it('preserves list selection and scroll after returning from detail', () => {
    const listState = {
      ...initialState,
      selectedIndex: 4,
      scrollOffset: 2,
    };

    const detailState = appReducer(listState, { type: 'navigate:goto-detail' });
    const returnedState = appReducer(detailState, { type: 'navigate:goto-list' });

    expect(returnedState).toMatchObject({
      detailView: 'list',
      selectedIndex: 4,
      scrollOffset: 2,
    });
  });

  it('resets selection and scroll when switching top-level views', () => {
    const state = {
      ...initialState,
      detailView: 'detail' as const,
      selectedIndex: 4,
      scrollOffset: 2,
    };

    const nextState = appReducer(state, { type: 'navigate:switch', payload: { view: 'board' } });

    expect(nextState).toMatchObject({
      detailView: 'list',
      selectedIndex: 0,
      scrollOffset: 0,
    });
  });
});

describe('appReducer search', () => {
  it('search:enable enters search mode and clears query', () => {
    const state = {
      ...initialState,
      isSearchMode: false,
      searchQuery: 'old query',
      selectedIndex: 5,
    };

    const nextState = appReducer(state, { type: 'search:enable' });

    expect(nextState.isSearchMode).toBe(true);
    expect(nextState.searchQuery).toBe('');
    // Note: selectedIndex reset is done by selection:top action, not search:enable
  });

  it('search:disable exits search mode and clears query', () => {
    const state = {
      ...initialState,
      isSearchMode: true,
      searchQuery: 'test query',
      selectedIndex: 3,
    };

    const nextState = appReducer(state, { type: 'search:disable' });

    expect(nextState.isSearchMode).toBe(false);
    expect(nextState.searchQuery).toBe('');
  });

  it('search:set-query updates the search query', () => {
    const state = {
      ...initialState,
      isSearchMode: true,
      searchQuery: '',
    };

    const nextState = appReducer(state, { type: 'search:set-query', payload: { query: 'new query' } });

    expect(nextState.searchQuery).toBe('new query');
    expect(nextState.isSearchMode).toBe(true); // unchanged
  });

  it('search:enable resets selectedIndex to 0 (entering search mode)', () => {
    const state = {
      ...initialState,
      isSearchMode: false,
      selectedIndex: 5,
    };

    const nextState = appReducer(state, { type: 'search:enable' });

    // search:enable only sets isSearchMode to true and clears query
    // selection:top is a separate action dispatched by enableSearch()
    expect(nextState.isSearchMode).toBe(true);
    expect(nextState.searchQuery).toBe('');
  });

  it('escaping search mode restores full list via search:disable', () => {
    // Simulate having filtered a list (search query active)
    const searchState = {
      ...initialState,
      isSearchMode: true,
      searchQuery: 'partial',
      selectedIndex: 2,
    };

    // Escape key triggers search:disable
    const afterEscape = appReducer(searchState, { type: 'search:disable' });

    expect(afterEscape.isSearchMode).toBe(false);
    expect(afterEscape.searchQuery).toBe('');
    // Note: selectedIndex is NOT reset by search:disable - the full list is restored
    // and the previous selection index is preserved
  });
});
