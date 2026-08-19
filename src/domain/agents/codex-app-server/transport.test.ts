import { EventEmitter } from 'node:events';
import type WebSocket from 'ws';
import { describe, expect, it, vi } from 'vitest';
import { closeWebSocket, waitForWebSocketOpen } from './transport';

describe('waitForWebSocketOpen', () => {
  it('terminates a socket that does not open before the startup timeout', async () => {
    const socket = new EventEmitter() as EventEmitter & { terminate: ReturnType<typeof vi.fn> };
    socket.terminate = vi.fn();

    await expect(waitForWebSocketOpen(socket as unknown as WebSocket, 5)).rejects.toThrow(/timed out/i);

    expect(socket.terminate).toHaveBeenCalledOnce();
    expect(socket.listenerCount('open')).toBe(0);
    expect(() => socket.emit('error', new Error('closed while connecting'))).not.toThrow();
    expect(socket.listenerCount('error')).toBe(0);
  });
});

describe('closeWebSocket', () => {
  it('waits for close and terminates a peer that ignores the close frame', async () => {
    const socket = new EventEmitter() as EventEmitter & {
      readyState: number;
      close: ReturnType<typeof vi.fn>;
      terminate: ReturnType<typeof vi.fn>;
    };
    socket.readyState = 1;
    socket.close = vi.fn();
    socket.terminate = vi.fn(() => queueMicrotask(() => socket.emit('close')));

    await closeWebSocket(socket as unknown as WebSocket, 5);

    expect(socket.close).toHaveBeenCalledOnce();
    expect(socket.terminate).toHaveBeenCalledOnce();
    expect(socket.listenerCount('close')).toBe(0);
  });
});
