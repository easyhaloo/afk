import { describe, expect, it, vi } from 'vitest';
import { LoopRunner } from './loop-runner';
import type { ProviderBundle } from '../core/providers';
import type { BacklogItem } from '../core/backlog';

const item: BacklogItem = {
  id: '42',
  title: 'verify me',
  dependsOn: [],
  state: 'verification',
  executionMode: 'afk',
  tags: [],
  branchName: 'afk/backlog-42',
  providerRef: 'github:org/repo#42',
};

describe('LoopRunner QA boundary', () => {
  it('passes a claim-free backlog facade to QARunner', async () => {
    const providers: ProviderBundle = {
      backlog: {
        get: vi.fn(async () => item),
        list: vi.fn(async () => []),
        claim: vi.fn(),
        transition: vi.fn(async () => {}),
        setExecutionMode: vi.fn(async () => {}),
        addTag: vi.fn(async () => {}),
        removeTag: vi.fn(async () => {}),
        initialize: vi.fn(async () => {}),
        isRunnable: vi.fn(async () => false),
      },
      branches: {} as ProviderBundle['branches'],
      changes: {} as ProviderBundle['changes'],
    };
    const qaFactory = vi.fn(() => ({ process: vi.fn(async () => ({ success: true })) }) as any);
    const subject = new LoopRunner(providers, { qaRunnerFactory: qaFactory });
    const internals = subject as any;
    internals.running = true;
    internals.qaQueue.push('42');

    await internals.runQA();

    expect(qaFactory).toHaveBeenCalledTimes(1);
    const managementBundle = qaFactory.mock.calls[0][0];
    expect('claim' in managementBundle.backlog).toBe(false);
    expect(managementBundle.backlog.get).toBeDefined();
    expect(managementBundle.backlog.transition).toBeDefined();
  });
});
