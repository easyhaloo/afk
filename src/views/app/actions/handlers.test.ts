import { describe, expect, it, vi } from 'vitest';
import { createActions, openBacklogUrl } from './handlers.js';
import { inMemoryRuntimePorts } from '../../../../tests/support/runtime-ports.js';
import type { StateContextValue } from '../state/StateContext.js';
import { initialState } from '../state/initialState.js';

function context(): StateContextValue {
  return {
    state: initialState,
    dispatch: vi.fn(),
    currentView: 'backlogs',
    currentContext: {},
    isDetailMode: false,
  };
}

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

describe('createActions', () => {
  it('opens a backlog link through the browser capability it was given', async () => {
    const opened: string[] = [];
    const ports = inMemoryRuntimePorts();
    ports.browser.open = async (url: string) => { opened.push(url); };

    const actions = createActions(context(), ports);

    await expect(actions.openBacklog({ id: '42', webUrl: 'https://example.test/42' })).resolves.toBe(true);
    expect(opened).toEqual(['https://example.test/42']);
  });

  it('reports a backlog with no provider URL without opening anything', async () => {
    const opened: string[] = [];
    const ports = inMemoryRuntimePorts();
    ports.browser.open = async (url: string) => { opened.push(url); };

    const actions = createActions(context(), ports);

    await expect(actions.openBacklog({ id: '42' })).resolves.toBe(false);
    expect(opened).toEqual([]);
  });
});
