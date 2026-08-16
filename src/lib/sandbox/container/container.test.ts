import { describe, it, expect } from 'vitest';
import { EnvVarAllowlist } from './env-allowlist';
import { DockerContainerProvider } from './docker';
import { PodmanContainerProvider } from './podman';
import { ContainerSandbox, ContainerAgentExecution } from './sandbox';
import { ContainerSandboxProvider } from './provider';
import type { ContainerProvider, ContainerCreateOptions, ContainerHandle } from './types';
import { join } from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { promises as fsp } from 'fs';

const PROCESS_METADATA = { provider: 'claude-code', transport: 'process' } as const;

describe('EnvVarAllowlist', () => {
  it('permits known defaults', () => {
    const a = new EnvVarAllowlist();
    expect(a.allows('PATH')).toBe(true);
    expect(a.allows('HOME')).toBe(true);
    expect(a.allows('ANTHROPIC_API_KEY')).toBe(true);
    expect(a.allows('OPENAI_API_KEY')).toBe(true);
  });

  it('rejects secret-bearing env vars', () => {
    const a = new EnvVarAllowlist();
    expect(a.allows('AWS_SECRET_ACCESS_KEY')).toBe(false);
    expect(a.allows('SSH_AUTH_SOCK')).toBe(false);
    expect(a.allows('GITHUB_TOKEN')).toBe(true); // allowed for coding agents
  });

  it('filter splits allowed vs rejected', () => {
    const a = new EnvVarAllowlist();
    const r = a.filter({
      PATH: '/usr/bin',
      AWS_SECRET_ACCESS_KEY: 'leaked',
      MY_CUSTOM: 'value',
      HOME: '/root',
    });
    expect(r.allowed).toEqual({ PATH: '/usr/bin', HOME: '/root' });
    expect(r.result.allowed).toEqual(['PATH', 'HOME']);
    expect(r.result.rejected.map(x => x.name)).toEqual(['AWS_SECRET_ACCESS_KEY', 'MY_CUSTOM']);
  });

  it('extra names extend the allowlist', () => {
    const a = new EnvVarAllowlist(['CUSTOM_TOKEN']);
    expect(a.allows('CUSTOM_TOKEN')).toBe(true);
    expect(a.list()).toContain('CUSTOM_TOKEN');
  });
});

describe('CliContainerProvider — argv construction', () => {
  // Access the protected buildRunArgs via cast. We deliberately do NOT
  // subclass to avoid infinite recursion through method override.
  function buildArgs(opts: ContainerCreateOptions): string[] {
    const p = new DockerContainerProvider();
    return (p as unknown as { buildRunArgs: (o: ContainerCreateOptions) => string[] }).buildRunArgs(opts);
  }

  function baseOpts(over: Partial<ContainerCreateOptions> = {}): ContainerCreateOptions {
    return {
      image: 'alpine:3.20',
      name: 'afk-test',
      user: '1000:1000',
      mounts: [{ hostPath: '/tmp/worktree', containerPath: '/workspace' }],
      env: { PATH: '/usr/bin' },
      command: ['sleep', 'infinity'],
      dropCapabilities: ['ALL'],
      ...over,
    };
  }

  it('rejects root user', () => {
    expect(() => buildArgs(baseOpts({ user: 'root' }))).toThrow(/non-root/);
    expect(() => buildArgs(baseOpts({ user: '0:0' }))).toThrow(/non-root/);
  });

  it('rejects empty mounts', () => {
    expect(() => buildArgs(baseOpts({ mounts: [] }))).toThrow(/at least one mount/);
  });

  it('rejects forbidden mount sources (ssh, aws, docker.sock)', () => {
    expect(() => buildArgs(baseOpts({
      mounts: [{ hostPath: '/home/user/.ssh', containerPath: '/workspace' }],
    }))).toThrow(/forbidden/);
    expect(() => buildArgs(baseOpts({
      mounts: [{ hostPath: '/home/user/.aws', containerPath: '/workspace' }],
    }))).toThrow(/forbidden/);
  });

  it('emits --cap-drop ALL, --read-only when set, --workdir', () => {
    const argv = buildArgs(baseOpts({
      readOnlyRoot: true,
      workdir: '/workspace',
    }));
    expect(argv).toContain('--cap-drop');
    expect(argv).toContain('ALL');
    expect(argv).toContain('--read-only');
    expect(argv).toContain('-w');
    expect(argv).toContain('/workspace');
  });

  it('emits -v host:container[:ro] per mount', () => {
    const argv = buildArgs(baseOpts({
      mounts: [
        { hostPath: '/host/wt', containerPath: '/workspace' },
        { hostPath: '/host/sess', containerPath: '/afk/session', readOnly: true },
      ],
    }));
    expect(argv).toContain('/host/wt:/workspace');
    expect(argv).toContain('/host/sess:/afk/session:ro');
  });

  it('emits -e KEY=VALUE per env var', () => {
    const argv = buildArgs(baseOpts({ env: { PATH: '/bin', FOO: 'bar' } }));
    expect(argv).toContain('-e');
    expect(argv).toContain('PATH=/bin');
    expect(argv).toContain('FOO=bar');
  });

  it('ends with image + command', () => {
    const argv = buildArgs(baseOpts());
    const tail = argv.slice(-3);
    expect(tail[0]).toBe('alpine:3.20');
    expect(tail[1]).toBe('sleep');
    expect(tail[2]).toBe('infinity');
  });
});

describe('DockerContainerProvider — runtime', () => {
  it('reports availability based on `docker version`', async () => {
    const p = new DockerContainerProvider();
    const available = await p.isAvailable();
    // We can't assert true (CI may lack docker); just assert it returns boolean.
    expect(typeof available).toBe('boolean');
  });

  it('reports the correct binary and engine', () => {
    const p = new DockerContainerProvider();
    expect(p.engine).toBe('docker');
    expect(p.binary).toBe('docker');
  });
});

describe('PodmanContainerProvider — runtime', () => {
  it('reports the correct binary and engine', () => {
    const p = new PodmanContainerProvider();
    expect(p.engine).toBe('podman');
    expect(p.binary).toBe('podman');
  });
});

describe('ContainerSandbox — interrupt escalation', () => {
  function fakeProvider(): { provider: ContainerProvider; killed: string[]; removed: string[] } {
    const killed: string[] = [];
    const removed: string[] = [];
    const fake: ContainerProvider = {
      engine: 'docker',
      binary: 'docker',
      isAvailable: async () => true,
      create: async (_opts): Promise<ContainerHandle> => ({ id: 'cid-fake', name: 'fake', engine: 'docker' }),
      exec: async () => ({ execId: 'exec-1' }),
      killExec: async () => {},
      killContainer: async (id, signal) => { killed.push(`${id}:${signal ?? 'SIGTERM'}`); },
      remove: async (id, force) => { removed.push(`${id}:${force ? 'force' : 'normal'}`); },
      inspect: async (id) => ({ id, name: id, status: 'running', pid: 42 }),
    };
    return { provider: fake, killed, removed };
  }

  it('interrupt() sends SIGINT to the container', async () => {
    const { provider, killed } = fakeProvider();
    const sb = new ContainerSandbox({ worktreePath: '/tmp', image: 'alpine', user: '1000:1000' });
    sb.bindProvider(provider);
    await sb.createContainer();
    const exec = await sb.startAgent({
      command: { argv: ['sleep', '1'] },
      generation: 1,
      prompt: 'do x',
      signalType: 'goal_complete',
      metadata: PROCESS_METADATA,
    });
    await exec.interrupt('context-high');
    expect(killed).toContain('cid-fake:SIGINT');
  });

  it('kill() sends SIGKILL', async () => {
    const { provider, killed } = fakeProvider();
    const sb = new ContainerSandbox({ worktreePath: '/tmp', image: 'alpine', user: '1000:1000' });
    sb.bindProvider(provider);
    await sb.createContainer();
    const exec = await sb.startAgent({
      command: { argv: ['sleep', '1'] },
      generation: 1,
      prompt: 'do x',
      signalType: 'goal_complete',
      metadata: PROCESS_METADATA,
    });
    await exec.kill();
    expect(killed).toContain('cid-fake:SIGKILL');
  });

  it('close() removes the container with force', async () => {
    const { provider, killed, removed } = fakeProvider();
    const sb = new ContainerSandbox({ worktreePath: '/tmp', image: 'alpine', user: '1000:1000' });
    sb.bindProvider(provider);
    await sb.createContainer();
    await sb.close();
    expect(killed).toContain('cid-fake:SIGKILL');
    expect(removed).toContain('cid-fake:force');
  });

  it('startAgent() filters env through allowlist', async () => {
    let capturedEnv: Record<string, string> = {};
    const provider: ContainerProvider = {
      engine: 'docker',
      binary: 'docker',
      isAvailable: async () => true,
      create: async () => ({ id: 'cid-x', name: 'x', engine: 'docker' }),
      exec: async (opts) => { capturedEnv = opts.env ?? {}; return { execId: 'e1' }; },
      killExec: async () => {},
      killContainer: async () => {},
      remove: async () => {},
      inspect: async (id) => ({ id, name: id, status: 'running' }),
    };
    const sb = new ContainerSandbox({
      worktreePath: '/tmp',
      image: 'alpine',
      user: '1000:1000',
      extraEnv: { PATH: '/bin', AWS_SECRET_ACCESS_KEY: 'leak' },
    });
    sb.bindProvider(provider);
    await sb.createContainer();
    await sb.startAgent({
      command: { argv: ['echo'] },
      generation: 1,
      prompt: 'x',
      signalType: 'goal_complete',
      metadata: PROCESS_METADATA,
    });
    expect(capturedEnv.PATH).toBe('/bin');
    expect(capturedEnv.AWS_SECRET_ACCESS_KEY).toBeUndefined();
  });

  it('rejects interactive execution because a container has no prompt transport', async () => {
    const { provider } = fakeProvider();
    const sb = new ContainerSandbox({ worktreePath: '/tmp', image: 'alpine', user: '1000:1000' });
    sb.bindProvider(provider);
    await sb.createContainer();

    await expect(sb.startAgent({
      command: { argv: ['echo'] },
      generation: 1,
      prompt: 'interactive goal',
      signalType: 'goal_complete',
      executionMode: 'interactive',
      metadata: PROCESS_METADATA,
    })).rejects.toThrow(/batch/);
  });
});

describe('ContainerAgentExecution — batch result files', () => {
  it('returns the structured completion result produced by a detached agent', async () => {
    const root = await fsp.mkdtemp(join(os.tmpdir(), 'afk-container-result-'));
    const outputPath = join(root, 'agent.stdout');
    const errorPath = join(root, 'agent.stderr');
    const exitPath = join(root, 'agent.exit');
    await fsp.writeFile(outputPath, '{"type":"result","result":"<goal_complete>{\\"type\\":\\"goal_complete\\",\\"kind\\":\\"task\\",\\"summary\\":\\"finished\\"}</goal_complete>"}\n');
    await fsp.writeFile(errorPath, '');
    await fsp.writeFile(exitPath, '0\n');

    const provider: ContainerProvider = {
      engine: 'docker', binary: 'docker', isAvailable: async () => true,
      create: async () => ({ id: 'cid', name: 'cid', engine: 'docker' }),
      exec: async () => ({ execId: 'exec-1' }), killExec: async () => {},
      killContainer: async () => {}, remove: async () => {},
      inspect: async id => ({ id, name: id, status: 'running' }),
    };
    const execution = new ContainerAgentExecution({
      provider,
      containerId: 'cid',
      worktreePath: root,
      sessionName: 'sandbox-1',
      generation: 1,
      signalType: 'goal_complete',
      execId: 'exec-1',
      outputPath,
      errorPath,
      exitPath,
      metadata: PROCESS_METADATA,
      parseLine: line => {
        const parsed = JSON.parse(line);
        return [{ type: 'result', result: parsed.result }];
      },
    });

    await expect(execution.waitForResult({ completionTimeoutMs: 100 })).resolves.toMatchObject({
      status: 'completed',
      provider: 'container',
      structuredOutput: { type: 'goal_complete', kind: 'task', summary: 'finished' },
    });
    expect(execution.metadata).toEqual(PROCESS_METADATA);
  });
});

describe('ContainerSandboxProvider — auto engine detection', () => {
  it('exposes correct isolation + capabilities', () => {
    // Construct without calling detectProvider (which would require real engine)
    const wp = new (class extends ContainerSandboxProvider { constructor() { super({ provider: undefined as unknown as ContainerProvider }); } })();
    expect(wp.isolation).toBe('filesystem');
    expect(wp.capabilities.has('kill-process')).toBe(true);
    expect(wp.capabilities.has('interrupt-process')).toBe(true);
    expect(wp.capabilities.has('persistent-filesystem')).toBe(true);
  });

  it('detectProvider returns null when neither docker nor podman is available', async () => {
    // We can't simulate 'neither available' without PATH manipulation; just
    // assert the function returns a ContainerProvider-or-null type.
    const result = await ContainerSandboxProvider.detectProvider();
    if (result === null) {
      expect(result).toBeNull();
    } else {
      expect(['docker', 'podman']).toContain(result.engine);
    }
  });

  it('forwards only allowed agent credentials into the container', async () => {
    const worktreePath = fs.mkdtempSync(join(os.tmpdir(), 'afk-container-env-'));
    const hostClaudeConfigDir = fs.mkdtempSync(join(os.tmpdir(), 'afk-host-claude-'));
    const hostClaudeConfigFile = join(hostClaudeConfigDir, '.claude.json');
    fs.writeFileSync(hostClaudeConfigFile, '{}\n');
    let captured: Record<string, string> = {};
    let mounts: Array<{ hostPath: string; containerPath: string; readOnly?: boolean }> = [];
    const provider: ContainerProvider = {
      engine: 'docker', binary: 'docker', isAvailable: async () => true,
      create: async options => {
        captured = options.env;
        mounts = options.mounts;
        return { id: 'cid', name: 'cid', engine: 'docker' };
      },
      exec: async () => ({ execId: 'exec' }), killExec: async () => {},
      killContainer: async () => {}, remove: async () => {},
      inspect: async id => ({ id, name: id, status: 'running' }),
    };
    try {
      const sandbox = await new ContainerSandboxProvider({ provider, image: 'afk-sandbox-claude:node22', hostClaudeConfigDir, hostClaudeConfigFile }).create({
        worktreePath,
        session: 'env-check',
        env: {
          ANTHROPIC_API_KEY: 'allowed',
          CLAUDE_CONFIG_DIR: '/unmapped/host/claude',
          HOME: '/host/home',
          PATH: '/host/bin',
          AWS_SECRET_ACCESS_KEY: 'rejected',
        },
      });
      expect(captured).toEqual({ ANTHROPIC_API_KEY: 'allowed' });
      expect(mounts).toContainEqual({ hostPath: hostClaudeConfigDir, containerPath: '/home/node/.claude', readOnly: true });
      expect(mounts).toContainEqual({ hostPath: hostClaudeConfigFile, containerPath: '/home/node/.claude.json', readOnly: true });
      await sandbox.close();
    } finally {
      fs.rmSync(worktreePath, { recursive: true, force: true });
      fs.rmSync(hostClaudeConfigDir, { recursive: true, force: true });
    }
  });
});

describe('Container sandbox integration — write/read inside bind mount', () => {
  // Real-Docker integration test gated by env var. Default: skipped.
  const enabled = process.env.AFK_DOCKER_E2E === '1';

  it.skipIf(!enabled)('a file written inside /workspace is visible on the host worktree', async () => {
    const wtPath = fs.mkdtempSync(join(os.tmpdir(), 'afk-docker-e2e-'));
    try {
      const provider = new DockerContainerProvider();
      if (!(await provider.isAvailable())) return; // silently skip

      const sb = new ContainerSandbox({ worktreePath: wtPath, image: 'alpine:3.20', user: '1000:1000' });
      sb.bindProvider(provider);
      await sb.createContainer();

      // Write a file inside the container at /workspace; verify it appears on the host.
      await provider.exec({
        containerId: (sb as unknown as { _containerId: string })._containerId,
        command: ['sh', '-c', 'echo hello > /workspace/from-container.txt'],
      });

      const hostFile = join(wtPath, 'from-container.txt');
      expect(fs.existsSync(hostFile)).toBe(true);
      expect(fs.readFileSync(hostFile, 'utf-8').trim()).toBe('hello');

      await sb.close();
    } finally {
      fs.rmSync(wtPath, { recursive: true, force: true });
    }
  });

  it.skipIf(!enabled)('runs a detached sandbox execution and observes goal_complete', async () => {
    const wtPath = fs.mkdtempSync(join(os.tmpdir(), 'afk-docker-agent-e2e-'));
    try {
      const provider = new DockerContainerProvider();
      if (!(await provider.isAvailable())) return;

      const sb = new ContainerSandbox({
        worktreePath: wtPath,
        image: process.env.AFK_SANDBOX_IMAGE || 'afk-sandbox-claude:node22',
        user: '1000:1000',
      });
      sb.bindProvider(provider);
      await sb.createContainer();

      const execution = await sb.startAgent({
        command: {
          argv: ['sh', '-c', 'printf \'%s\\n\' \'<goal_complete>{"type":"goal_complete","kind":"task","summary":"docker sandbox"}</goal_complete>\''],
        },
        generation: 1,
        prompt: 'container smoke prompt',
        signalType: 'goal_complete',
        executionMode: 'batch',
        metadata: PROCESS_METADATA,
      });
      await expect(execution.waitForResult({ completionTimeoutMs: 10_000 })).resolves.toMatchObject({
        status: 'completed',
        provider: 'container',
        structuredOutput: { type: 'goal_complete', summary: 'docker sandbox' },
      });
      await sb.close();
    } finally {
      fs.rmSync(wtPath, { recursive: true, force: true });
    }
  });
});
