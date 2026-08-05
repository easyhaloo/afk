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

describe('appReducer search state transitions', () => {
  it('enables search mode and resets query', () => {
    const state = { ...initialState, isSearchMode: false, searchQuery: 'previous' };
    const nextState = appReducer(state, { type: 'search:enable' });

    expect(nextState.isSearchMode).toBe(true);
    expect(nextState.searchQuery).toBe('');
  });

  it('disables search mode and clears query', () => {
    const state = { ...initialState, isSearchMode: true, searchQuery: 'test' };
    const nextState = appReducer(state, { type: 'search:disable' });

    expect(nextState.isSearchMode).toBe(false);
    expect(nextState.searchQuery).toBe('');
  });

  it('sets search query to provided value', () => {
    const state = { ...initialState, isSearchMode: true, searchQuery: '' };
    const nextState = appReducer(state, { type: 'search:set-query', payload: { query: 'backend' } });

    expect(nextState.searchQuery).toBe('backend');
  });

  it('handles empty query when setting search query', () => {
    const state = { ...initialState, isSearchMode: true, searchQuery: 'test' };
    const nextState = appReducer(state, { type: 'search:set-query', payload: { query: '' } });

    expect(nextState.searchQuery).toBe('');
  });

  it('search:disable preserves detailView (setDetailView: null in policy)', () => {
    const state = { ...initialState, isSearchMode: true, searchQuery: 'test', detailView: 'detail' as const };
    const nextState = appReducer(state, { type: 'search:disable' });

    expect(nextState.isSearchMode).toBe(false);
    expect(nextState.searchQuery).toBe('');
    // setDetailView: null means preserve current detailView
    expect(nextState.detailView).toBe('detail');
  });

  it('search:enable preserves detailView (setDetailView: null in policy)', () => {
    const state = { ...initialState, detailView: 'list' as const };
    const nextState = appReducer(state, { type: 'search:enable' });

    expect(nextState.isSearchMode).toBe(true);
    expect(nextState.searchQuery).toBe('');
    // setDetailView: null means preserve current detailView
    expect(nextState.detailView).toBe('list');
  });
});
