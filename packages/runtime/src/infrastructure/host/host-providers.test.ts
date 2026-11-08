import { describe, expect, it, vi } from 'vitest';
import { PluginRuntime } from '../../application/plugins/runtime.js';
import { createHostPlugins } from '../../application/plugins/builtins-host.js';
import { createAwsSsmHostConnection } from './aws-ssm.js';
import { createKubernetesExecHostConnection } from './kubernetes-exec.js';
import { createSshHostConnection } from './ssh.js';
import type { HostCommandExecutor } from './command.js';

function recordingExecutor(results: Array<{ code: number; stdout?: string; stderr?: string }>): {
  exec: HostCommandExecutor;
  calls: Array<{ command: string; argv: readonly string[] }>;
} {
  const calls: Array<{ command: string; argv: readonly string[] }> = [];
  let index = 0;
  const exec: HostCommandExecutor = async (command, argv) => {
    calls.push({ command, argv });
    const result = results[Math.min(index++, results.length - 1)];
    return { code: result.code, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  };
  return { exec, calls };
}

describe('host providers', () => {
  it('quotes SSH remote argv and supports upload', async () => {
    const executor = recordingExecutor([{ code: 0 }, { code: 0 }]);
    const provider = createSshHostConnection({
      hosts: [{ alias: 'build', address: '10.0.0.4', username: 'runner', port: 2222, identityFile: '/tmp/id' }],
      exec: executor.exec,
    });

    await expect(provider.exec('build', ['printf', '%s', 'a b; special'])).resolves.toMatchObject({ code: 0 });
    await provider.upload?.('build', './artifact', '/tmp/artifact');

    expect(executor.calls).toEqual([
      { command: 'ssh', argv: ['-o', 'BatchMode=yes', '-p', '2222', '-i', '/tmp/id', '-T', '-l', 'runner', '--', '10.0.0.4', "'printf' '%s' 'a b; special'"] },
      { command: 'scp', argv: ['-O', '-o', 'BatchMode=yes', '-P', '2222', '-i', '/tmp/id', '--', `${process.cwd()}/artifact`, "runner@10.0.0.4:'/tmp/artifact'"] },
    ]);
  });

  it('executes AWS SSM with JSON commands and polls invocation output', async () => {
    const executor = recordingExecutor([
      { code: 0, stdout: JSON.stringify({ Command: { CommandId: 'cmd-1' } }) },
      { code: 0, stdout: JSON.stringify({ Status: 'Success', ResponseCode: 0, StandardOutputContent: 'ok\n', StandardErrorContent: '' }) },
    ]);
    const provider = createAwsSsmHostConnection({
      hosts: [{ alias: 'worker', instanceId: 'i-123', region: 'us-east-1' }],
      exec: executor.exec,
      pollIntervalMs: 0,
    });

    await expect(provider.exec('worker', ['echo', 'hello world'])).resolves.toEqual({ code: 0, stdout: 'ok\n', stderr: '' });
    expect(executor.calls[0]).toEqual({
      command: 'aws',
      argv: [
        'ssm', 'send-command', '--instance-ids', 'i-123', '--document-name', 'AWS-RunShellScript',
        '--parameters', JSON.stringify({ commands: ["'echo' 'hello world'"], executionTimeout: ['30'] }), '--output', 'json', '--no-cli-pager', '--region=us-east-1',
      ],
    });
    expect(executor.calls[1].argv).toContain('cmd-1');
  });

  it('discovers Kubernetes pods and keeps command arguments structured', async () => {
    const executor = recordingExecutor([
      { code: 0, stdout: JSON.stringify({ items: [{ metadata: { name: 'api-0', namespace: 'prod' }, status: { podIP: '10.0.0.2' } }] }) },
      { code: 0, stdout: 'ok', stderr: '' },
    ]);
    const provider = createKubernetesExecHostConnection({ exec: executor.exec, namespace: 'prod' });

    await expect(provider.listHosts()).resolves.toEqual([{ id: 'prod/api-0', alias: 'prod/api-0', address: '10.0.0.2', provider: 'kubernetes-exec' }]);
    await expect(provider.exec('prod/api-0', ['sh', '-c', 'printf "%s" "$HOME"'])).resolves.toMatchObject({ code: 0, stdout: 'ok' });
    expect(executor.calls[1]).toEqual({
      command: 'kubectl',
      argv: ['exec', '--namespace=prod', 'api-0', '--', 'sh', '-c', 'printf "%s" "$HOME"'],
    });
  });

  it('preserves an AWS SSM remote failure without treating it as a transport failure', async () => {
    const executor = recordingExecutor([
      { code: 0, stdout: JSON.stringify({ Command: { CommandId: 'cmd-1' } }) },
      { code: 0, stdout: JSON.stringify({ Status: 'Failed', ResponseCode: 42, StandardOutputContent: 'partial\n', StandardErrorContent: 'test failed\n' }) },
    ]);
    const provider = createAwsSsmHostConnection({ exec: executor.exec });
    await expect(provider.exec('i-123', ['test'])).resolves.toEqual({ code: 42, stdout: 'partial\n', stderr: 'test failed\n' });
    expect(executor.calls).toHaveLength(2);
  });

  it('exposes all built-in providers through the plugin runtime', async () => {
    const runtime = new PluginRuntime();
    for (const plugin of createHostPlugins({
      ssh: { hosts: [] },
      awsSsm: { hosts: [] },
      kubernetes: { hosts: [] },
    })) await runtime.activate(plugin);

    expect(runtime.listHostProviders()).toEqual(['ssh', 'aws-ssm', 'kubernetes-exec']);
  });

  it('classifies missing external binaries through HostFailure', async () => {
    const exec = vi.fn<HostCommandExecutor>(async () => { throw new Error('spawn kubectl ENOENT'); });
    const provider = createKubernetesExecHostConnection({ exec });

    await expect(provider.listHosts()).rejects.toMatchObject({ name: 'HostFailure', code: 'binary-missing' });
  });
});
