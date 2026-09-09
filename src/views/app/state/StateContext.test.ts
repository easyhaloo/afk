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

  it('accepts an explicitly allowed plugin view and rejects unknown views', () => {
    const pluginView = 'plugin:example:status';
    const allowedViews = new Set(['tasks', 'backlogs', 'projects', 'board', pluginView]);

    const nextState = appReducer(
      initialState,
      { type: 'navigate:switch', payload: { view: pluginView } },
      allowedViews,
    );
    expect(nextState.viewStack.at(-1)?.view).toBe(pluginView);

    expect(appReducer(
      initialState,
      { type: 'navigate:switch', payload: { view: 'plugin:unknown:status' } },
      allowedViews,
    )).toEqual(initialState);
  });
});
