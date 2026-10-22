import { describe, expect, it, vi } from 'vitest';
import { createExecutionWorker } from '../../electron/adapters/execution-worker-adapter.js';
import type { spawn } from 'node:child_process';

describe('execution worker adapter', () => {
  it('launches the bundled runtime in a detached Node process with structured input', () => {
    const child = { pid: 42 };
    const launch = vi.fn(() => child);
    const input = { workItemId: 'github:acme/app#42', manifestPath: '/workspace/.afk/execution-manifest.json', executionId: 'desktop-42' };
    const result = createExecutionWorker('/app/execution-worker.js', '/app/Electron', launch as unknown as typeof spawn)(input, '/workspace');
    expect(result).toBe(child);
    expect(launch).toHaveBeenCalledWith('/app/Electron', ['/app/execution-worker.js', JSON.stringify(input)], {
      cwd: '/workspace', detached: true, stdio: 'ignore', env: expect.objectContaining({ ELECTRON_RUN_AS_NODE: '1', PWD: '/workspace' }),
    });
  });
});
