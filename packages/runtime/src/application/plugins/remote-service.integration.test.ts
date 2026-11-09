import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { ClaudeCodeProvider } from '../../domain/agents/claude-code.js';
import { ContainerSandboxProvider } from '../../infrastructure/sandbox/container/provider.js';
import { DockerContainerProvider } from '../../infrastructure/sandbox/container/docker.js';
import { createRemoteContainerHttpTransport, RemoteContainerSandboxProvider } from '../../infrastructure/sandbox/remote-container.js';
import { buildExecutionPrompt } from '../workflows/execution-protocol.js';
import { startRemoteContainerService } from './remote-service.js';
import { PluginRuntime } from './runtime.js';

const enabled = process.env.AFK_DOCKER_E2E === '1' && process.env.AFK_REAL_CLAUDE_E2E === '1';
const execute = promisify(execFile);

it.skipIf(!enabled)('runs real Claude through authenticated remote HTTP and Docker, then independently verifies generated code', async () => {
  expect(process.env.CLAUDE_CONFIG_DIR, 'Set CLAUDE_CONFIG_DIR to the authenticated Claude configuration directory.').toBeTruthy();
  expect(await new DockerContainerProvider().isAvailable(), 'Start a reachable Docker engine before opting into real container acceptance.').toBe(true);
  const configuration = await realpath(process.env.CLAUDE_CONFIG_DIR!);
  const root = await realpath(await mkdtemp(join(tmpdir(), 'afk-remote-docker-claude-')));
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  const runtime = new PluginRuntime();
  const agent = new ClaudeCodeProvider();
  const provider = new ContainerSandboxProvider({
    hostClaudeConfigDir: configuration,
    hostClaudeConfigFile: join(dirname(configuration), '.claude.json'),
  });
  const token = randomBytes(32).toString('hex');
  let service: Awaited<ReturnType<typeof startRemoteContainerService>> | undefined;
  let sandbox: Awaited<ReturnType<RemoteContainerSandboxProvider['create']>> | undefined;
  try {
    await runtime.activate({
      manifest: { id: 'integration.remote-container', version: '0.1.0', apiVersion: 1, trusted: true, provides: ['sandbox.provider', 'agent.provider'] },
      activate(context) {
        context.registerSandboxProvider('docker', provider);
        context.registerAgentProvider('claude-code', agent);
      },
    });
    service = await startRemoteContainerService(runtime, {
      token, repositoryRoot: workspace, workspaceRoot: workspace,
      sandboxProviderId: 'docker', allowedAgents: ['claude-code'], port: 0,
    });
    const baseUrl = `http://127.0.0.1:${service.address.port}`;
    expect((await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(5000) })).status).toBe(401);
    const transport = createRemoteContainerHttpTransport({ baseUrl, token, timeoutMs: 15000 });
    expect(await transport.health!()).toBe(true);
    sandbox = await new RemoteContainerSandboxProvider(transport).create({
      worktreePath: workspace, session: 'remote-docker-acceptance', executionMode: 'batch',
    });
    const goal = '/goal Work only in /workspace. Create sum.mjs exporting function sum(a,b) returning a+b and sum.test.mjs using node:test and node:assert/strict to test positive, negative and decimal inputs. Run node --test /workspace/sum.test.mjs and fix failures. Do not install dependencies, access other workspaces, call browser/MCP tools, commit, or push. Complete only when both files exist and all tests pass.';
    const execution = await agent.createExecution({
      sandbox, worktreePath: sandbox.workspacePath, sessionId: 'remote-docker-acceptance', generation: 1,
      goal, prompt: buildExecutionPrompt(goal, 'batch', 'task'), signalType: 'goal_complete', executionMode: 'batch',
    });
    expect((await execution.waitForResult({ completionTimeoutMs: 180000 })).status).toBe('completed');
    expect((await readFile(join(workspace, 'sum.mjs'), 'utf8')).length).toBeGreaterThan(0);
    const moduleUrl = pathToFileURL(join(workspace, 'sum.mjs')).href;
    await execute(process.execPath, ['--input-type=module', '-e', `import assert from 'node:assert/strict'; const {sum}=await import(${JSON.stringify(moduleUrl)}); assert.equal(sum(2,3),5); assert.equal(sum(-2,-3),-5); assert.equal(sum(1.25,2.75),4);`], { timeout: 15000 });
    await execute(process.execPath, ['--test', join(workspace, 'sum.test.mjs')], { timeout: 15000 });
  } finally {
    try { await sandbox?.close(); }
    finally {
      try { await service?.close(); }
      finally {
        try { await runtime.dispose(); }
        finally { await rm(root, { recursive: true, force: true }); }
      }
    }
  }
}, 240000);
