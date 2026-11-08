import { describe, expect, it } from 'vitest';
import { LifecycleDispatcher, type LifecycleContext } from './lifecycle.js';

const context: LifecycleContext = {
  iid: 1, repoRoot: '/repo', projectName: 'org/repo', worktreePath: '/repo/.worktrees/1',
  baseBranch: 'main', sessionName: 'afk-1', params: {},
};

describe('LifecycleDispatcher', () => {
  it('runs typed phases in deterministic order and cleanup in reverse order', async () => {
    const calls: string[] = [];
    const dispatcher = new LifecycleDispatcher([
      { name: 'b', order: 20, onBeforeAgent: async () => calls.push('b:before'), onCleanup: async () => calls.push('b:cleanup') },
      { name: 'a', order: 10, onBeforeAgent: async () => calls.push('a:before'), onCleanup: async () => calls.push('a:cleanup') },
    ]);
    await dispatcher.run('before-agent', context);
    await dispatcher.run('cleanup', context);
    expect(calls).toEqual(['a:before', 'b:before', 'b:cleanup', 'a:cleanup']);
  });

  it('blocks required policy failures while still draining cleanup hooks', async () => {
    const calls: string[] = [];
    const dispatcher = new LifecycleDispatcher([
      { name: 'later', onBeforeAgent: async () => { calls.push('agent'); }, onCleanup: async () => { calls.push('cleanup'); } },
      { name: 'policy', order: -1, failureMode: 'required', onBeforeAgent: async () => { throw new Error('policy denied'); }, onCleanup: async () => { throw new Error('cleanup failed'); } },
    ]);
    await expect(dispatcher.run('before-agent', context)).rejects.toThrow('policy denied');
    expect(calls).toEqual([]);
    await dispatcher.run('cleanup', context);
    expect(calls).toEqual(['cleanup']);
  });
});
