import { describe, expect, it, vi } from 'vitest';
import { KeyboardDispatcher, ViewRegistry } from './index';
import type { Notification, View } from './index';

function makeView(id: string, priority: number): View {
  return { id, name: id, shortcut: id[0], priority, render: () => null };
}

describe('shared TUI core', () => {
  it('preserves global keyboard dispatch and ignores unmatched keys', () => {
    const dispatcher = new KeyboardDispatcher();
    const handler = vi.fn();
    dispatcher.setActiveView('first');
    dispatcher.registerGlobal('escape', handler);
    dispatcher.registerGlobal('x', handler);
    dispatcher.dispatch({ key: 'x', input: 'x', ctrl: false, shift: false, meta: false });
    dispatcher.dispatch({ key: 'escape', input: '', ctrl: false, shift: false, meta: false });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('preserves priority and active-view behavior', () => {
    const registry = new ViewRegistry();
    registry.register(makeView('low', 1));
    registry.register(makeView('high', 10));
    registry.setActive('high');
    expect(registry.getAll().map(view => view.id)).toEqual(['high', 'low']);
    expect(registry.getActive()?.id).toBe('high');
    registry.unregister('high');
    expect(registry.getActive()).toBeUndefined();
  });

  it('exposes the notification contract to TUI consumers', () => {
    const notification: Notification = { type: 'info', message: 'ready' };
    expect(notification.message).toBe('ready');
  });
});
