import { describe, expect, it, vi } from 'vitest';
import type { createJumpserverCli } from './jms-cli.js';
import { classifyJmsFailure, createJmsHostConnection } from './host-connection.js';

type Cli = ReturnType<typeof createJumpserverCli>;

function makeCli(overrides: Partial<Cli> = {}): Cli {
  const base = {
    listServers: async () => [{ alias: 'bastion', host: '10.0.0.1', username: 'admin', isDefault: true }],
    addServer: async (input: { alias: string }) => ({ ok: true, alias: input.alias }),
    removeServer: async () => true,
    listAssets: async () => [
      { name: 'web-01', address: '10.0.1.10', platform: 'Linux', rawType: 'Ubuntu' },
      { name: 'db-01', address: '10.0.2.10', platform: 'Linux', rawType: 'Debian' },
    ],
    probeAssetReachability: async () => true,
    execAssetCommand: async () => ({ ok: true, stdout: 'out', stderr: '', code: 0 }),
    uploadFile: async () => ({ ok: true, stdout: '', stderr: '', code: 0 }),
    resolveBinaryPath: async () => '/usr/local/bin/jms',
  };
  return { ...base, ...overrides } as Cli;
}

describe('classifyJmsFailure', () => {
  it('maps each diagnostic to its stable code', () => {
    expect(classifyJmsFailure({ ok: false, stderr: 'spawn jms ENOENT' })).toBe('binary-missing');
    expect(classifyJmsFailure({ ok: false, stderr: 'unknown server alias "bastion"' })).toBe('server-unknown');
    expect(classifyJmsFailure({ ok: false, stderr: 'permission denied, please try again' })).toBe('auth-required');
    expect(classifyJmsFailure({ ok: false, stderr: 'unknown asset web-99' })).toBe('asset-unknown');
    expect(classifyJmsFailure({ ok: false, stderr: 'jms exec timed out after 8000ms' })).toBe('unreachable');
    expect(classifyJmsFailure({ ok: false, stderr: 'connection refused' })).toBe('unreachable');
    expect(classifyJmsFailure({ ok: false, stderr: 'command exited 2', code: 2 })).toBe('remote-failed');
  });

  it('treats a spawn-level ENOENT as binary-missing even with an exit code', () => {
    expect(classifyJmsFailure({ ok: false, message: 'spawn jms ENOENT', code: null })).toBe('binary-missing');
  });
});

describe('createJmsHostConnection', () => {
  it('forwards user argv verbatim as structured arguments to jms exec', async () => {
    const execAssetCommand = vi.fn(async () => ({ ok: true, stdout: 'ok', stderr: '', code: 0 }));
    const connection = createJmsHostConnection({
      cli: makeCli({ execAssetCommand }) as Cli,
      serverAlias: 'bastion',
    });

    await connection.exec('web-01', ['sh', '-c', 'echo "hello world"; rm -rf /tmp/x'], { timeoutMs: 1234 });

    expect(execAssetCommand).toHaveBeenCalledWith({
      target: 'web-01@bastion',
      // The whole vector is passed through untouched — no quoting, no joining.
      argv: ['sh', '-c', 'echo "hello world"; rm -rf /tmp/x'],
      timeoutMs: 1234,
    });
  });

  it('exec returns the remote exit code and streams on success', async () => {
    const connection = createJmsHostConnection({
      cli: makeCli({ execAssetCommand: async () => ({ ok: true, stdout: 'done', stderr: '', code: 0 }) }) as Cli,
      serverAlias: 'bastion',
    });
    await expect(connection.exec('web-01', ['true'])).resolves.toEqual({ code: 0, stdout: 'done', stderr: '' });
  });

  it('preserves a non-zero remote exit and both output streams', async () => {
    const connection = createJmsHostConnection({
      cli: makeCli({ execAssetCommand: async () => ({ ok: false, stdout: 'partial output', stderr: 'exit status 1', code: 1 }) }) as Cli,
      serverAlias: 'bastion',
    });
    await expect(connection.exec('web-01', ['false'])).resolves.toEqual({ code: 1, stdout: 'partial output', stderr: 'exit status 1' });
  });

  it('maps a timeout to the unreachable category', async () => {
    const connection = createJmsHostConnection({
      cli: makeCli({ execAssetCommand: async () => ({ ok: false, stdout: '', stderr: 'jms timed out after 50ms', code: null }) }) as Cli,
      serverAlias: 'bastion',
    });
    await expect(connection.exec('web-01', ['sleep', '5'], { timeoutMs: 50 })).rejects.toMatchObject({ code: 'unreachable' });
  });

  it('throws binary-missing before invoking the CLI when jms is absent', async () => {
    const execAssetCommand = vi.fn();
    const connection = createJmsHostConnection({
      cli: makeCli({ resolveBinaryPath: async () => '', execAssetCommand }) as Cli,
      serverAlias: 'bastion',
    });
    await expect(connection.exec('web-01', ['true'])).rejects.toMatchObject({ code: 'binary-missing' });
    expect(execAssetCommand).not.toHaveBeenCalled();
  });

  it('throws server-unknown when the bound server lists no assets', async () => {
    const connection = createJmsHostConnection({
      cli: makeCli({ listAssets: async () => [] }) as Cli,
      serverAlias: 'ghost',
    });
    await expect(connection.resolve('web-01')).rejects.toMatchObject({ code: 'server-unknown' });
  });

  it('throws asset-unknown when the target asset is not listed', async () => {
    const connection = createJmsHostConnection({
      cli: makeCli() as Cli,
      serverAlias: 'bastion',
    });
    await expect(connection.resolve('nope-01')).rejects.toMatchObject({ code: 'asset-unknown' });
    await expect(connection.exec('nope-01', ['true'])).rejects.toMatchObject({ code: 'asset-unknown' });
  });

  it('requires a bound server when the host is not asset@server', async () => {
    const connection = createJmsHostConnection({ cli: makeCli() as Cli });
    await expect(connection.exec('web-01', ['true'])).rejects.toMatchObject({ code: 'server-unknown' });
  });

  it('parses an explicit asset@server host over the bound default', async () => {
    const listAssets = vi.fn(async (alias: string) =>
      alias === 'other' ? [{ name: 'web-01', address: '10.9.9.9', platform: 'Linux', rawType: 'X' }] : [],
    );
    const connection = createJmsHostConnection({ cli: makeCli({ listAssets }) as Cli, serverAlias: 'bastion' });
    const record = await connection.resolve('web-01@other');
    expect(listAssets).toHaveBeenCalledWith('other');
    expect(record).toMatchObject({ alias: 'web-01@other', address: '10.9.9.9', provider: 'jumpserver' });
  });

  it('resolves an asset by address on the bound server', async () => {
    const connection = createJmsHostConnection({ cli: makeCli() as Cli, serverAlias: 'bastion' });
    const byAddress = await connection.resolve('10.0.2.10');
    expect(byAddress).toMatchObject({ alias: 'db-01@bastion', address: '10.0.2.10', provider: 'jumpserver' });
  });

  it('lists hosts across all servers when no server is bound', async () => {
    const listServers = vi.fn(async () => [{ alias: 'bastion', host: '10.0.0.1', username: 'admin', isDefault: true }]);
    const connection = createJmsHostConnection({ cli: makeCli({ listServers }) as Cli });
    const hosts = await connection.listHosts();
    expect(listServers).toHaveBeenCalled();
    expect(hosts.map(host => host.alias)).toEqual(['web-01@bastion', 'db-01@bastion']);
  });

  it('lists hosts for the bound server without querying the server list', async () => {
    const listServers = vi.fn();
    const connection = createJmsHostConnection({ cli: makeCli({ listServers }) as Cli, serverAlias: 'bastion' });
    const hosts = await connection.listHosts();
    expect(listServers).not.toHaveBeenCalled();
    expect(hosts).toHaveLength(2);
  });

  it('uploads via a structured argv file transfer', async () => {
    const uploadFile = vi.fn(async () => ({ ok: true, stdout: '', stderr: '', code: 0 }));
    const connection = createJmsHostConnection({ cli: makeCli({ uploadFile }) as Cli, serverAlias: 'bastion' });
    await connection.upload('web-01', '/tmp/local.bin', '/remote/path.bin');
    expect(uploadFile).toHaveBeenCalledWith({
      target: 'web-01@bastion',
      source: '/tmp/local.bin',
      destination: '/remote/path.bin',
      timeoutMs: undefined,
    });
  });

  it('rejects uploads for unknown assets before invoking file transfer', async () => {
    const uploadFile = vi.fn(async () => ({ ok: true, stdout: '', stderr: '', code: 0 }));
    const connection = createJmsHostConnection({ cli: makeCli({ uploadFile }) as Cli, serverAlias: 'bastion' });
    await expect(connection.upload('missing-01', '/tmp/local.bin', '/remote/path.bin')).rejects.toMatchObject({ code: 'asset-unknown' });
    expect(uploadFile).not.toHaveBeenCalled();
  });

  it('classifies an auth failure from the CLI stderr', async () => {
    const connection = createJmsHostConnection({
      cli: makeCli({ execAssetCommand: async () => ({ ok: false, stdout: '', stderr: 'permission denied', code: 5 }) }) as Cli,
      serverAlias: 'bastion',
    });
    await expect(connection.exec('web-01', ['whoami'])).rejects.toMatchObject({ code: 'auth-required' });
  });
});
