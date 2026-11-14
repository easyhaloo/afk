import { describe, expect, it, vi } from 'vitest';
import { CursorProvider } from '../../domain/agents/cursor.js';
import { PiProvider } from '../../domain/agents/pi.js';
import type { AgentExecution, AgentProvider, AgentStartOptions, SessionSnapshot } from '../../domain/agents/types.js';
import type { Sandbox } from '../../infrastructure/sandbox/types.js';
import type { SessionStoreChain } from '../sessions/types.js';
import { attemptNativeResume } from './resume.js';

const worktreePath = '/tmp/bridge-fixture';
const context = {
  iid: 42, session: 'afk-logical-new', wtPath: worktreePath, runId: 'fixture', generation: 2,
  signalType: 'goal_complete' as const, prompt: 'fixture', executionMode: 'batch' as const,
};

function fixture(provider: AgentProvider) {
  const snapshot: SessionSnapshot = {
    sessionId: 'native-from-store', generation: 1,
    checkpoint: { version: 1, provider: provider.name, sessionId: 'native-from-store', worktreePath },
    summary: 'fixture', capturedAt: '2026-11-13T00:00:00.000Z',
  };
  const startAgent = vi.fn(async (_start: AgentStartOptions) => ({ id: 'fixture', metadata: {} } as AgentExecution));
  const beforeStart = vi.fn(async () => {});
  const chain = { loadFirst: vi.fn(async () => ({ snapshot, storeName: 'fixture' })) } as unknown as SessionStoreChain;
  const sandbox = { startAgent } as unknown as Sandbox;
  return { snapshot, startAgent, beforeStart, chain, sandbox };
}

describe('native resume workflow bridge', () => {
  it.each([
    { name: 'cursor', create: () => new CursorProvider(), flag: '--resume' },
    { name: 'pi', create: () => new PiProvider(), flag: '--session' },
  ])('$name carries the stored checkpoint into the native command instead of the new logical ID', async ({ create, flag }) => {
    const provider = create();
    const host = fixture(provider);
    const createExecution = vi.spyOn(provider, 'createExecution');
    const execution = await attemptNativeResume(context, provider, host.sandbox, () => host.chain, host.beforeStart);
    expect(execution).toBeDefined();
    expect(host.chain.loadFirst).toHaveBeenCalledWith({ runId: context.runId });
    expect(host.beforeStart).toHaveBeenCalledOnce();
    expect(createExecution.mock.calls[0][0].resume).toBe(host.snapshot);
    expect(createExecution.mock.calls[0][0]).toMatchObject({ sessionId: context.session, generation: 2, executionMode: 'batch' });
    expect(host.startAgent).toHaveBeenCalledOnce();
    expect(host.startAgent.mock.calls[0][0].command.argv.slice(-2)).toEqual([flag, host.snapshot.sessionId]);
  });

  it('does not reserve a handoff or launch when the stored checkpoint fails preflight', async () => {
    const provider = new CursorProvider();
    const host = fixture(provider);
    host.snapshot.checkpoint = null;
    expect(await attemptNativeResume(context, provider, host.sandbox, () => host.chain, host.beforeStart)).toBeUndefined();
    expect(host.beforeStart).not.toHaveBeenCalled();
    expect(host.startAgent).not.toHaveBeenCalled();
  });

  it('falls back when no snapshot exists without launching a fresh session as a native resume', async () => {
    const provider = new PiProvider();
    const host = fixture(provider);
    vi.mocked(host.chain.loadFirst).mockResolvedValue(null);
    expect(await attemptNativeResume(context, provider, host.sandbox, () => host.chain, host.beforeStart)).toBeUndefined();
    expect(host.beforeStart).not.toHaveBeenCalled();
    expect(host.startAgent).not.toHaveBeenCalled();
  });

  it('returns to the coordinator if the native launch fails after reservation', async () => {
    const provider = new PiProvider();
    const host = fixture(provider);
    host.startAgent.mockRejectedValue(new Error('controlled native launch failure'));
    expect(await attemptNativeResume(context, provider, host.sandbox, () => host.chain, host.beforeStart)).toBeUndefined();
    expect(host.beforeStart).toHaveBeenCalledOnce();
    expect(host.startAgent).toHaveBeenCalledOnce();
  });
});
