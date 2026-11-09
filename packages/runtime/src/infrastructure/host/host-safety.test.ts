import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAwsSsmHostConnection } from './aws-ssm.js';
import { classifyHostFailure, createHostCommandExecutor, runHostCommand, shellQuote, type HostCommandExecutor } from './command.js';
import { createKubernetesExecHostConnection } from './kubernetes-exec.js';
import { createSshHostConnection } from './ssh.js';

const success = (stdout = '') => ({ code: 0, stdout, stderr: '' });
const json = (value: unknown) => success(JSON.stringify(value));
const sent = { Command: { CommandId: 'command-123' } };
const completed = { Status: 'Success', ResponseCode: 0, StandardOutputContent: '', StandardErrorContent: '' };

afterEach(() => { vi.useRealTimers(); });

describe('SSH command and path safety', () => {
  it('preserves argv through a real remote shell parser', async () => {
    const argv = ['', 'a b', "one'two", '$HOME', '$(printf injected)', '; printf injected', '\n', '*'];
    const execute = createHostCommandExecutor();
    const provider = createSshHostConnection({ exec: async (_command, args) => execute('/bin/sh', ['-c', args.at(-1)!]) });
    const result = await provider.exec('alice@[::1]:2222', [process.execPath, '-e', 'console.log(JSON.stringify(process.argv.slice(1)))', ...argv]);
    expect(JSON.parse(result.stdout)).toEqual(argv);
  });

  it('keeps hostile SCP paths literal and local paths local', async () => {
    const execute = createHostCommandExecutor();
    const destination = "-report's $(printf injected); *.json";
    const exec = vi.fn<Parameters<HostCommandExecutor>, ReturnType<HostCommandExecutor>>(async (_command, args) => {
      expect(args).toContain(resolve('local:name'));
      expect(args).toContain('-O');
      const remotePath = args.at(-1)!.slice('alice@host:'.length);
      const parsed = await execute('/bin/sh', ['-c', `${shellQuote(process.execPath)} -e 'console.log(JSON.stringify(process.argv.slice(1)))' ${remotePath}`]);
      expect(JSON.parse(parsed.stdout)).toEqual([`./${destination}`]);
      return success();
    });
    await createSshHostConnection({ exec }).upload!('alice@host', 'local:name', destination);
  });

  it.each(['-oProxyCommand=printf', 'user@-host', 'a b', 'host:99999'])('rejects invalid target %s before spawning', async target => {
    const exec = vi.fn(async () => success());
    await expect(createSshHostConnection({ exec }).exec(target, ['true'])).rejects.toMatchObject({ name: 'HostFailure' });
    expect(exec).not.toHaveBeenCalled();
  });

  it('does not mistake a remote exit 127 or remote permissions for a missing local binary/auth failure', async () => {
    for (const code of [127, 1]) {
      await expect(createSshHostConnection({ exec: async () => ({ code, stdout: '', stderr: 'permission denied: no such file or directory' }) })
        .exec('host', ['tool'])).resolves.toEqual({ code, stdout: '', stderr: 'permission denied: no such file or directory' });
    }
    await expect(createSshHostConnection({ exec: async () => ({ code: 1, stdout: '', stderr: 'scp: dest open: permission denied' }) })
      .upload!('host', 'source', '/report')).rejects.toMatchObject({ code: 'remote-failed' });
  });
});

describe('real process cancellation', () => {
  it('terminates descendants even when the parent exits on SIGTERM', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'host-process-tree-'));
    const pidPath = join(directory, 'child-pid');
    const controller = new AbortController();
    const childSource = 'process.on("SIGTERM", () => {}); require("node:fs").writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000)';
    const source = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(childSource)}, process.argv[1]], { stdio: 'inherit' }); setInterval(() => {}, 1000);`;
    let childPid: number | undefined;
    try {
      const outcome = expect(createHostCommandExecutor()(process.execPath, ['-e', source, pidPath], {
        timeoutMs: 5000, signal: controller.signal,
      })).rejects.toMatchObject({ code: 'unreachable' });
      await vi.waitFor(() => expect(existsSync(pidPath)).toBe(true));
      childPid = Number(readFileSync(pidPath, 'utf8'));
      controller.abort();
      await outcome;
      await vi.waitFor(() => expect(() => process.kill(childPid!, 0)).toThrow());
    } finally {
      if (childPid) { try { process.kill(childPid, 'SIGKILL'); } catch {} }
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each(['timeout', 'abort'] as const)('kills a process ignoring SIGTERM on %s', async mode => {
    const directory = mkdtempSync(join(tmpdir(), 'host-process-'));
    const pidPath = join(directory, 'pid');
    const controller = new AbortController();
    const source = 'process.on("SIGTERM", () => {}); require("node:fs").writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000)';
    try {
      const outcome = expect(createHostCommandExecutor()(process.execPath, ['-e', source, pidPath], {
        timeoutMs: mode === 'timeout' ? 500 : 5000, signal: controller.signal,
      })).rejects.toMatchObject({ code: 'unreachable', message: expect.stringMatching(mode === 'timeout' ? /timed out/ : /cancelled/) });
      await vi.waitFor(() => expect(existsSync(pidPath)).toBe(true));
      const pid = Number(readFileSync(pidPath, 'utf8'));
      if (mode === 'abort') controller.abort();
      await outcome;
      expect(() => process.kill(pid, 0)).toThrow();
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('does not spawn a pre-cancelled operation and preserves ENOENT classification', async () => {
    const exec = vi.fn(async () => success());
    await expect(runHostCommand(exec, 'tool', [], { signal: AbortSignal.abort() })).rejects.toMatchObject({ code: 'unreachable' });
    expect(exec).not.toHaveBeenCalled();
    await expect(runHostCommand(createHostCommandExecutor(), '/nonexistent/host-binary', [])).rejects.toMatchObject({ code: 'binary-missing' });
    expect(classifyHostFailure({ code: 127, stderr: 'command not found' })).toBe('remote-failed');
  });
});

describe('SSM invocation state machine', () => {
  it('retries eventual consistency and waits through pending/cancelling states', async () => {
    const invocations = [
      { code: 254, stdout: '', stderr: 'InvocationDoesNotExist' },
      json({ Status: 'Pending' }), json({ Status: 'InProgress' }), json({ Status: 'Cancelling' }), json(completed),
    ];
    const exec = vi.fn(async (_command: string, args: readonly string[]) => args.includes('send-command') ? json(sent) : invocations.shift()!);
    const provider = createAwsSsmHostConnection({ exec, pollIntervalMs: 0 });
    await expect(provider.exec('i-123', ['echo', "it's literal"])).resolves.toEqual(success());
    expect(exec).toHaveBeenCalledTimes(6);
    const parameters = JSON.parse(exec.mock.calls[0][1][exec.mock.calls[0][1].indexOf('--parameters') + 1]);
    expect(parameters.commands).toEqual(["'echo' 'it'\\''s literal'"]);
  });

  it.each([
    { Status: 'Success' }, { ...completed, ResponseCode: 1 }, { Status: 'FutureStatus' },
    null, {}, { Status: 'Failed', ResponseCode: 2 }, { Status: 'Cancelled' },
  ])('rejects invalid or failed invocation %j', async response => {
    const exec = vi.fn(async (_command: string, args: readonly string[]) => args.includes('send-command') ? json(sent)
      : args.includes('cancel-command') ? success() : json(response));
    await expect(createAwsSsmHostConnection({ exec }).exec('i-123', ['true'])).rejects.toMatchObject({ name: 'HostFailure' });
    if (!response || !['Success', 'Failed', 'Cancelled'].includes(response.Status ?? '')) {
      expect(exec.mock.calls.some(([, args]) => args.includes('cancel-command'))).toBe(true);
    }
  });

  it('cancels remotely on malformed invocation JSON', async () => {
    const exec = vi.fn(async (_command: string, args: readonly string[]) => args.includes('send-command') ? json(sent)
      : args.includes('cancel-command') ? success() : success('{broken'));
    await expect(createAwsSsmHostConnection({ exec }).exec('i-123', ['true'])).rejects.toThrow(/invalid JSON/);
    expect(exec.mock.calls.at(-1)![1]).toContain('cancel-command');
  });

  it('uses one total deadline and sends cancel-command when it expires', async () => {
    vi.useFakeTimers();
    const exec = vi.fn(async (_command: string, args: readonly string[]) => args.includes('send-command') ? json(sent)
      : args.includes('cancel-command') ? success() : json({ Status: 'Pending' }));
    const outcome = expect(createAwsSsmHostConnection({ exec, pollIntervalMs: 10 }).exec('i-123', ['true'], { timeoutMs: 25 }))
      .rejects.toMatchObject({ code: 'unreachable', message: expect.stringMatching(/timed out/) });
    await vi.advanceTimersByTimeAsync(30);
    await outcome;
    expect(exec.mock.calls.at(-1)![1]).toContain('cancel-command');
    expect(exec.mock.calls.length).toBeLessThan(8);
  });

  it('does not reuse an aborted signal for remote cancellation', async () => {
    const controller = new AbortController();
    const exec: HostCommandExecutor = vi.fn(async (_command, args, options) => {
      if (args.includes('send-command')) return json(sent);
      if (args.includes('get-command-invocation')) { controller.abort(); return json({ Status: 'Pending' }); }
      expect(args).toContain('cancel-command');
      expect(options?.signal).toBeUndefined();
      return success();
    });
    await expect(createAwsSsmHostConnection({ exec }).exec('i-123', ['true'], { signal: controller.signal }))
      .rejects.toMatchObject({ code: 'unreachable' });
    expect(exec).toHaveBeenCalledTimes(3);
  });

  it('surfaces cancellation failure and validates discovery JSON', async () => {
    vi.useFakeTimers();
    const exec: HostCommandExecutor = async (_command, args) => {
      if (args.includes('send-command')) return json(sent);
      if (args.includes('cancel-command')) return { code: 254, stdout: '', stderr: 'AccessDeniedException' };
      return json({ Status: 'Pending' });
    };
    const outcome = expect(createAwsSsmHostConnection({ exec }).exec('i-123', ['true'], { timeoutMs: 5 }))
      .rejects.toThrow(/remote cancellation failed/);
    await vi.advanceTimersByTimeAsync(10);
    await outcome;
    await expect(createAwsSsmHostConnection({ exec: async () => json({}) }).listHosts()).rejects.toThrow(/invalid JSON/);
  });

  it('discovers only managed Unix nodes and rejects missing command ids', async () => {
    const provider = createAwsSsmHostConnection({ exec: async () => json({ InstanceInformationList: [
      { InstanceId: 'i-123', ComputerName: 'worker', IPAddress: '10.0.0.1', PlatformType: 'Linux' },
      { InstanceId: 'i-124', ComputerName: 'windows', PlatformType: 'Windows' },
    ] }) });
    await expect(provider.listHosts()).resolves.toEqual([{ id: 'i-123', alias: 'worker', address: '10.0.0.1', provider: 'aws-ssm' }]);
    await expect(createAwsSsmHostConnection({ exec: async () => json({}) }).exec('i-123', ['true'])).rejects.toThrow(/invalid JSON/);
    await expect(createAwsSsmHostConnection({ exec: async (_command, args) => json(args.includes('send-command') ? sent : { Status: 'TimedOut' }) }).exec('i-123', ['true']))
      .rejects.toMatchObject({ code: 'unreachable' });
  });
});

describe('kubectl failures and path handling', () => {
  it('returns a confirmed remote exit code and both output streams', async () => {
    const result = { code: 127, stdout: 'partial output\n', stderr: 'permission denied\ncommand terminated with exit code 127\n' };
    const provider = createKubernetesExecHostConnection({ exec: async () => result });
    await expect(provider.exec('default/api', ['tool'])).resolves.toEqual(result);
  });

  it.each([
    ['Error from server (NotFound): pods "missing" not found', 'asset-unknown'],
    ['error: context "missing" does not exist', 'server-unknown'],
    ['Error from server (Forbidden): pods is forbidden', 'auth-required'],
    ['Unable to connect to the server: connection refused', 'unreachable'],
    ['permission denied\ncommand terminated with exit code 127', 'remote-failed'],
  ])('classifies %s as %s', async (stderr, code) => {
    const provider = createKubernetesExecHostConnection({ exec: async () => ({ code: 1, stdout: '', stderr }) });
    await expect(provider.exec('default/api', ['tool'])).rejects.toMatchObject({ code });
  });

  it('uses safe cp operands and rejects malformed pod targets and JSON', async () => {
    const exec = vi.fn(async () => success());
    const provider = createKubernetesExecHostConnection({ exec });
    await provider.upload!('prod/api', 'local:name', '-report $.txt');
    expect(exec.mock.calls[0]).toEqual(['kubectl', ['cp', '--namespace=prod', '--', resolve('local:name'), 'api:./-report $.txt'], undefined]);
    await expect(provider.exec('-bad', ['true'])).rejects.toMatchObject({ code: 'asset-unknown' });
    await expect(provider.upload!('api', 'source', 'other:target')).rejects.toMatchObject({ code: 'remote-failed' });
    await expect(createKubernetesExecHostConnection({ exec: async () => json(null) }).listHosts()).rejects.toThrow(/invalid JSON/);
  });
});
