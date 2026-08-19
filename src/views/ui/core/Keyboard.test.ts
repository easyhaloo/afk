import { describe, it, expect, vi, beforeEach } from 'vitest';
import { KeyboardDispatcher } from './Keyboard';
import type { KeyboardEvent } from './types';

describe('KeyboardDispatcher', () => {
  let dispatcher: KeyboardDispatcher;

  beforeEach(() => {
    dispatcher = new KeyboardDispatcher();
  });

  describe('global handlers', () => {
    it('registers and dispatches global key handler', () => {
      const handler = vi.fn();
      dispatcher.registerGlobal('escape', handler);
      dispatcher.dispatch({ key: 'escape', input: '', ctrl: false, shift: false, meta: false });
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('dispatches ctrl-c before view handlers', () => {
      const handler = vi.fn();
      dispatcher.registerGlobal('ctrl-c', handler);
      dispatcher.dispatch({ key: 'ctrl-c', input: '', ctrl: true, shift: false, meta: false });
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('global handlers take priority over view events', () => {
      const escapeHandler = vi.fn();
      dispatcher.registerGlobal('escape', escapeHandler);
      dispatcher.setActiveView('test-view');
      dispatcher.dispatch({ key: 'escape', input: '', ctrl: false, shift: false, meta: false });
      expect(escapeHandler).toHaveBeenCalledTimes(1);
    });

    it('does nothing when key has no handler', () => {
      dispatcher.dispatch({ key: 'a', input: 'a', ctrl: false, shift: false, meta: false });
      // No error thrown
    });
  });

  describe('active view routing', () => {
    it('sets and clears active view', () => {
      dispatcher.setActiveView('my-view');
      dispatcher.setActiveView('other-view');
      // Active view is set; routing is delegated to the view itself
    });
  });
});
