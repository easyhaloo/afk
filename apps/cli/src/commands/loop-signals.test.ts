import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { installLoopSignalHandlers } from './loop-signals.js';

describe('loop shutdown signals', () => {
  it('registers only when invoked, shares one shutdown, and removes both listeners', async () => {
    const signals = new EventEmitter();
    let finish!: () => void;
    const stop = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    const notify = vi.fn();
    const remove = installLoopSignalHandlers(stop, notify, vi.fn(), signals);
    signals.emit('SIGINT');
    signals.emit('SIGTERM');
    signals.emit('SIGINT');
    expect(stop).toHaveBeenCalledOnce();
    expect(notify).toHaveBeenCalledOnce();
    finish();
    await stop.mock.results[0].value;
    remove();
    expect(signals.listenerCount('SIGINT')).toBe(0);
    expect(signals.listenerCount('SIGTERM')).toBe(0);
  });
});
