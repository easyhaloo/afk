import { describe, expect, it } from 'vitest';
import { appReducer } from './StateContext.js';
import { initialState } from './initial-state.js';

describe('appReducer navigation', () => {
  it('keeps built-in views reachable when plugin views are registered', () => {
    const allowed = new Set(['plugin:example:status']);
    const plugin = appReducer(initialState, { type: 'navigate:switch', payload: { view: 'plugin:example:status' } }, allowed);
    expect(plugin.viewStack.at(-1)?.view).toBe('plugin:example:status');
    const returned = appReducer(plugin, { type: 'navigate:switch', payload: { view: 'tasks' } }, allowed);
    expect(returned.viewStack.at(-1)?.view).toBe('tasks');
    expect(appReducer(returned, { type: 'navigate:switch', payload: { view: 'plugin:unknown:status' } }, allowed)).toBe(returned);
  });

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
