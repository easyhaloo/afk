import { describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';

/**
 * The core package owns the agent execution mode vocabulary: the mode an
 * agent run executes in, as opposed to the mode a work item carries. The
 * audit spine records it, the execution runtime drives it, the CLI asks for
 * it and the desktop client reads it.
 *
 * This test grows the vocabulary the core package publishes and then asks
 * the entry points whether they grew with it. An entry point that keeps its
 * own copy of the list rejects the new value, and that rejection is the
 * defect: the answer to "which modes can an agent run use" would differ
 * from the package that owns the answer.
 */
vi.mock('@afk/core', async importOriginal => {
  const original = await importOriginal<typeof import('@afk/core')>();
  return {
    ...original,
    AGENT_EXECUTION_MODES: [...original.AGENT_EXECUTION_MODES, 'headless'],
    isAgentExecutionMode: (value: unknown) =>
      (value === 'headless' || original.isAgentExecutionMode(value)),
  };
});

import { AGENT_EXECUTION_MODES } from '@afk/core';
import { registerQACommands } from '../../src/cli/commands/qa';import { inMemoryRuntimePorts } from '../support/runtime-ports.js';

import { parseRuntimeHealth, parseWorkflowInstance } from '../../desktop-client/shared/execution-contract';

vi.mock('@afk/infrastructure', async importOriginal => ({
  ...await importOriginal<typeof import('@afk/infrastructure')>(),
  createManagementProviders: vi.fn(),
}));
vi.mock('@afk/execution/infrastructure/config/manager', () => ({
  getWorkflowConfig: () => ({}),
}));
vi.mock('@afk/execution/domain/agents/index', () => ({
  createAgentProvider: vi.fn(),
  prepareAgentRuntime: vi.fn(() => ({})),
  resolveAgentProviderName: vi.fn(() => 'claude-code'),
}));
vi.mock('../../src/cli/commands/agent-runtime-options', () => ({
  addAgentRuntimeOptions: (command: Command) => command,
  resolveAgentRuntimeOptions: () => ({}),
}));
vi.mock('@afk/execution/application/modules/qa-runner', () => ({ QARunner: vi.fn() }));

async function runQa(...args: string[]): Promise<void> {
  const program = new Command().exitOverride();
  registerQACommands(program, { ports: inMemoryRuntimePorts() });
  await program.parseAsync(['node', 'afk', 'qa', ...args]);
}

describe('The entry points answer with the agent mode vocabulary the core publishes', () => {
  it('names the modes the core package declares in the QA command', () => {
    const program = new Command();
    registerQACommands(program, { ports: inMemoryRuntimePorts() });
    const qa = program.commands.find(command => command.name() === 'qa');
    const mode = qa?.options.find(option => option.long === '--mode');
    for (const value of AGENT_EXECUTION_MODES) {
      expect(mode?.description).toContain(value);
    }
  });

  it('runs QA in every mode the core package declares', async () => {
    const { createManagementProviders } = await import('@afk/infrastructure');
    const { QARunner } = await import('@afk/execution/application/modules/qa-runner');
    const backlog = { get: vi.fn().mockResolvedValue({ id: 'item-1', state: 'verification' }) };
    const providers = { backlog };
    vi.mocked(createManagementProviders).mockResolvedValue(providers as never);
    vi.mocked(QARunner).mockImplementation(() => ({ process: vi.fn().mockResolvedValue({ success: true }) }) as never);

    for (const mode of AGENT_EXECUTION_MODES) {
      await runQa('--backlog-id', 'item-1', '--project', 'group/repo', '--mode', mode);
    }

    expect(QARunner).toHaveBeenCalledTimes(AGENT_EXECUTION_MODES.length);
    expect(vi.mocked(QARunner).mock.calls.at(-1)?.[2]).toMatchObject({ executionMode: 'headless' });
  });

  it('reads every mode the core package declares out of a runtime health payload', () => {
    for (const mode of AGENT_EXECUTION_MODES) {
      expect(parseRuntimeHealth({
        state: 'live',
        observedAt: '2026-09-15T00:00:00.000Z',
        reason: 'heartbeat',
        executionMode: mode,
      })).toMatchObject({ executionMode: mode });
    }
  });

  it('reads every mode the core package declares out of a workflow instance', () => {
    for (const mode of AGENT_EXECUTION_MODES) {
      expect(parseWorkflowInstance({
        name: 'workflow',
        version: 1,
        recordedAt: '2026-09-15T00:00:00.000Z',
        steps: [{ id: 'implement', kind: 'agent', dependsOn: [], status: 'pending', executionMode: mode }],
      }).steps[0]).toMatchObject({ executionMode: mode });
    }
  });

  it('refuses a mode the core package does not declare', () => {
    expect(() => parseRuntimeHealth({
      state: 'live',
      observedAt: '2026-09-15T00:00:00.000Z',
      reason: 'heartbeat',
      executionMode: 'manual',
    })).toThrow(/executionMode/i);
  });
});
