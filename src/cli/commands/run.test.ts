import { afterEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const mocks = vi.hoisted(() => ({
  runWorkflowCli: vi.fn(async () => ({ success: true })),
}));

vi.mock('@afk/execution/application/workflows/run-cmd', () => ({ runWorkflowCli: mocks.runWorkflowCli }));
vi.mock('@afk/execution/domain/agents/index', () => ({ resolveAgentProviderName: () => 'claude-code' }));
vi.mock('./agent-runtime-options', () => ({
  addAgentRuntimeOptions: (command: Command) => command,
  resolveAgentRuntimeOptions: () => ({ kind: 'default' }),
}));
vi.mock('../cli-utils', () => ({
  handleCommandError: (error: unknown) => { throw error; },
  success: vi.fn(),
  warning: vi.fn(),
  detail: vi.fn(),
}));

import { registerRunCommands } from './run.js';
import { inMemoryRuntimePorts, inMemoryWorkflowConfig } from '../../../tests/support/runtime-ports.js';

const roots: string[] = [];

describe('run command', () => {
  afterEach(async () => {
    vi.clearAllMocks();
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
  });

  it('accepts --execution-manifest and passes it to runWorkflowCli', async () => {
    const program = new Command().name('afk').exitOverride();
    registerRunCommands(program, { ports: inMemoryRuntimePorts() });

    await program.parseAsync([
      'node', 'afk', 'run', '--backlog-id', 'github:acme/api#42',
      '--execution-manifest', '/workspace/.afk/execution-manifest.json',
    ]);

    expect(mocks.runWorkflowCli).toHaveBeenCalledWith(expect.objectContaining({
      backlogId: 'github:acme/api#42',
      executionManifestPath: '/workspace/.afk/execution-manifest.json',
    }));
  });

  it('takes the run configuration from the port, not from the file on disk', async () => {
    // The command is a driver: it says what the user asked for, and the
    // configuration that shapes the run comes from the port the
    // composition root wired up. A command that reached for the runtime's
    // reader instead would read the project's own configuration - and the
    // project's configuration is not what the port was given.
    const project = await mkdtemp(join(tmpdir(), 'afk-run-config-'));
    roots.push(project);
    await mkdir(join(project, '.afk'), { recursive: true });
    await writeFile(join(project, '.afk', 'config.yml'), 'maxRetries: 9\n', 'utf8');
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(project);

    const ports = inMemoryRuntimePorts();
    ports.configuration = {
      ...ports.configuration,
      workflow: () => ({ ...inMemoryWorkflowConfig(), maxRetries: 3 }),
    };
    const program = new Command().name('afk').exitOverride();
    registerRunCommands(program, { ports });

    await program.parseAsync(['node', 'afk', 'run', '--backlog-id', 'github:acme/api#42']);

    expect(mocks.runWorkflowCli).toHaveBeenCalledWith(expect.objectContaining({ maxRetries: 3 }));
    cwd.mockRestore();
  });
});
