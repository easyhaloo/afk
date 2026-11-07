import { describe, expect, it, vi } from 'vitest';
import { HostFailure } from '@afk/core';
import { createHostApplication } from './host-exec.js';

function connectionWith(overrides: Partial<Parameters<typeof createHostApplication>[0]> = {}) {
  return {
    listHosts: async () => [],
    resolve: async () => ({ id: 'host-1', alias: 'demo', provider: 'ssh' }),
    exec: vi.fn(async () => ({ code: 0, stdout: 'ok', stderr: '' })),
    ...overrides,
  };
}

describe('host application', () => {
  it('passes argv without constructing a shell command', async () => {
    const exec = vi.fn(async () => ({ code: 0, stdout: 'ok', stderr: '' }));
    const application = createHostApplication(connectionWith({ exec }));

    await expect(application.exec({ host: 'demo', argv: ['docker', 'ps', '-a'], timeoutMs: 5000 })).resolves.toEqual({ code: 0, stdout: 'ok', stderr: '' });
    expect(exec).toHaveBeenCalledWith('demo', ['docker', 'ps', '-a'], { timeoutMs: 5000 });
  });

  it('rejects an empty argv before reaching the adapter', async () => {
    const exec = vi.fn();
    const application = createHostApplication(connectionWith({ exec }));

    await expect(application.exec({ host: 'demo', argv: [] })).rejects.toThrow('at least one argument');
    expect(exec).not.toHaveBeenCalled();
  });

  it('propagates adapter timeout options', async () => {
    const exec = vi.fn(async () => ({ code: 0, stdout: '', stderr: '' }));
    const application = createHostApplication(connectionWith({ exec }));
    await application.exec({ host: 'demo', argv: ['sleep', '1'] });
    expect(exec).toHaveBeenCalledWith('demo', ['sleep', '1'], { timeoutMs: undefined });
  });

  it('propagates classified adapter failures unchanged', async () => {
    const failure = new HostFailure('unreachable', 'jms timed out');
    const application = createHostApplication(connectionWith({ exec: vi.fn(async () => { throw failure; }) }));
    await expect(application.exec({ host: 'demo', argv: ['true'] })).rejects.toBe(failure);
  });

  it('lists hosts through the connection', async () => {
    const listHosts = vi.fn(async () => [{ id: '1', alias: 'demo', provider: 'ssh' }]);
    const application = createHostApplication(connectionWith({ listHosts }));
    await expect(application.listHosts()).resolves.toHaveLength(1);
    expect(listHosts).toHaveBeenCalled();
  });
});
