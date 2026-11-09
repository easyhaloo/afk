import type { HostConnectionPort, HostExecResult, HostFailureCode, HostRecord } from '@afk/core';
import { HostFailure } from '@afk/core';
import { createJumpserverCli, type JumpserverCliOptions } from './jms-cli.js';

export type JmsTarget = { asset: string; serverAlias: string };

/**
 * Classify a JumpServer CLI outcome into a stable {@link HostFailureCode}.
 *
 * `code` is the child process exit code (`null`/`undefined` when the process
 * could not be spawned, was signalled, or timed out). Spawn-level ENOENT is a
 * missing binary; a non-zero exit from `jms` is a remote failure.
 */
export function classifyJmsFailure(input: {
  stderr?: string;
  message?: string;
  code?: number | null;
  ok: boolean;
}): HostFailureCode {
  const text = `${input.message ?? ''} ${input.stderr ?? ''}`.toLowerCase();
  if (/enoent|spawn /.test(text) || /binary|not installed|no such file/.test(text)) return 'binary-missing';
  if (/unknown server|unknown alias|no such server|server .* not found|server alias .* not found/.test(text)) return 'server-unknown';
  if (/unknown asset|no such asset|asset .* not found|unknown host|name or service not known/.test(text)) return 'asset-unknown';
  if (/auth|permission denied|password|login failed|invalid credentials|not logged in/.test(text)) return 'auth-required';
  if (/timed out|timeout|connection refused|connection reset|network|unreachable|econnrefused|etimedout|dns/.test(text)) return 'unreachable';
  if (input.ok) return 'unreachable';
  return 'remote-failed';
}

function toFailure(input: { stderr?: string; message?: string; code?: number | null; ok: boolean }, fallbackMessage: string): HostFailure {
  const code = classifyJmsFailure(input);
  const detail = (input.stderr ?? input.message ?? '').trim();
  return new HostFailure(code, detail || fallbackMessage);
}

function parseTarget(host: string, defaultServerAlias?: string): JmsTarget {
  const at = host.lastIndexOf('@');
  if (at > 0) {
    const asset = host.slice(0, at).trim();
    const serverAlias = host.slice(at + 1).trim();
    if (asset && serverAlias) return { asset, serverAlias };
  }
  if (!defaultServerAlias) {
    throw new HostFailure('server-unknown', `no JumpServer server bound for host "${host}"; provide "asset@server"`);
  }
  return { asset: host.trim(), serverAlias: defaultServerAlias };
}

export type JmsHostConnectionOptions = {
  /** Pre-built shared CLI; defaults to `createJumpserverCli(options)`. */
  cli?: ReturnType<typeof createJumpserverCli>;
  /** Default JumpServer server alias used when a host is not `asset@server`. */
  serverAlias?: string;
} & JumpserverCliOptions;

function toHostRecord(asset: { name: string; address: string; platform: string }, serverAlias: string): HostRecord {
  return {
    id: `${serverAlias}/${asset.name}`,
    alias: `${asset.name}@${serverAlias}`,
    address: asset.address,
    provider: 'jumpserver',
  };
}

/**
 * Adapt the shared JumpServer CLI into the core {@link HostConnectionPort}.
 *
 * Every external invocation is a structured `argv` — user command vectors are
 * forwarded verbatim as `jms exec <asset>@<server> <argv...>` and are never
 * joined into a shell string.
 */
export function createJmsHostConnection(options: JmsHostConnectionOptions = {}): HostConnectionPort {
  const cli = options.cli ?? createJumpserverCli(options);
  const serverAlias = options.serverAlias;

  async function requireBinary(): Promise<string> {
    const binary = await cli.resolveBinaryPath();
    if (!binary) throw new HostFailure('binary-missing', 'jms CLI not found on PATH');
    return binary;
  }

  async function requireAsset(target: JmsTarget) {
    const assets = await cli.listAssets(target.serverAlias);
    if (!assets.length) throw new HostFailure('server-unknown', `no assets listed for JumpServer server "${target.serverAlias}"`);
    const asset =
      assets.find(row => row.name === target.asset) ??
      assets.find(row => row.address === target.asset);
    if (!asset) {
      throw new HostFailure('asset-unknown', `asset "${target.asset}" not found on JumpServer server "${target.serverAlias}"`);
    }
    return asset;
  }

  async function run<T>(operation: () => Promise<T>): Promise<T> {
    await requireBinary();
    try {
      return await operation();
    } catch (error) {
      if (error instanceof HostFailure) throw error;
      throw toFailure({ message: error instanceof Error ? error.message : String(error), ok: false }, 'JumpServer command failed');
    }
  }

  return {
    async listHosts(): Promise<readonly HostRecord[]> {
      return run(async () => {
        const servers = serverAlias ? [{ alias: serverAlias }] : await cli.listServers();
        const records: HostRecord[] = [];
        for (const server of servers) {
          const assets = await cli.listAssets(server.alias);
          for (const asset of assets) records.push(toHostRecord(asset, server.alias));
        }
        return records;
      });
    },

    async resolve(host: string): Promise<HostRecord> {
      return run(async () => {
        const target = parseTarget(host, serverAlias);
        const asset = await requireAsset(target);
        return toHostRecord(asset, target.serverAlias);
      });
    },

    async exec(host: string, argv: readonly string[], execOptions?: { timeoutMs?: number }): Promise<HostExecResult> {
      if (argv.length === 0) throw new HostFailure('remote-failed', 'host exec requires at least one argument');
      return run(async () => {
        const target = parseTarget(host, serverAlias);
        await requireAsset(target);
        const result = await cli.execAssetCommand({
          target: `${target.asset}@${target.serverAlias}`,
          argv,
          timeoutMs: execOptions?.timeoutMs,
        });
        if (!result.ok && (result.code === null || result.code === undefined || classifyJmsFailure(result) !== 'remote-failed')) {
          throw toFailure({ stderr: result.stderr, code: result.code, ok: result.ok }, `jms exec failed for ${target.asset}@${target.serverAlias}`);
        }
        if (result.code === null || result.code === undefined || !Number.isInteger(result.code) || result.code < 0) {
          throw new HostFailure('unreachable', 'jms exec ended without a valid exit code');
        }
        return { code: result.code, stdout: result.stdout, stderr: result.stderr };
      });
    },

    async upload(host: string, source: string, destination: string, uploadOptions?: { timeoutMs?: number }): Promise<void> {
      return run(async () => {
        const target = parseTarget(host, serverAlias);
        await requireAsset(target);
        const result = await cli.uploadFile({
          target: `${target.asset}@${target.serverAlias}`,
          source,
          destination,
          timeoutMs: uploadOptions?.timeoutMs,
        });
        if (!result.ok) {
          throw toFailure({ stderr: result.stderr, code: result.code, ok: result.ok }, `jms upload failed for ${target.asset}@${target.serverAlias}`);
        }
      });
    },
  };
}
