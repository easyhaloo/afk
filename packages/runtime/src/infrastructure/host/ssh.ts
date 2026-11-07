import { isIP } from 'node:net';
import { resolve } from 'node:path';
import type { HostExecResult, HostRecord } from '@afk/core';
import { HostFailure } from '@afk/core';
import {
  classifyHostFailure, createHostCommandExecutor, runHostCommand, shellQuote, toHostExecResult,
  validateArgv, validatePath, type CancellableHostConnection, type HostCommandExecutor,
} from './command.js';

export interface SshHostDefinition {
  readonly id?: string;
  readonly alias: string;
  readonly address: string;
  readonly username?: string;
  readonly port?: number;
  readonly identityFile?: string;
}

export interface SshHostConnectionOptions {
  readonly hosts?: readonly SshHostDefinition[];
  readonly username?: string;
  readonly port?: number;
  readonly identityFile?: string;
  readonly binary?: string;
  readonly scpBinary?: string;
  readonly exec?: HostCommandExecutor;
}

function record(host: SshHostDefinition): HostRecord {
  return { id: host.id ?? host.alias, alias: host.alias, address: host.address, provider: 'ssh' };
}

function validateHost(host: SshHostDefinition): SshHostDefinition {
  if (!(isIP(host.address) || /^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/.test(host.address))) {
    throw new HostFailure('asset-unknown', 'invalid SSH host address');
  }
  if (host.username !== undefined && !/^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/.test(host.username)) {
    throw new HostFailure('auth-required', 'invalid SSH username');
  }
  if (host.port !== undefined && (!Number.isInteger(host.port) || host.port < 1 || host.port > 65535)) {
    throw new HostFailure('server-unknown', 'SSH port must be an integer between 1 and 65535');
  }
  return host;
}

function parseTarget(value: string, options: SshHostConnectionOptions): SshHostDefinition {
  const match = value.match(/^(?:([^@]+)@)?(\[[a-fA-F0-9:]+\]|[^:@\s]+)(?::(\d+))?$/);
  const address = match?.[2].replace(/^\[|\]$/g, '') ?? (isIP(value) === 6 ? value : undefined);
  if (!address) throw new HostFailure('asset-unknown', 'invalid SSH host');
  return validateHost({
    alias: value, address, username: match?.[1] ?? options.username,
    port: match?.[3] ? Number(match[3]) : options.port, identityFile: options.identityFile,
  });
}

export function createSshHostConnection(options: SshHostConnectionOptions = {}): CancellableHostConnection {
  const exec = options.exec ?? createHostCommandExecutor();

  function definition(value: string): SshHostDefinition {
    const host = options.hosts?.find(candidate => [candidate.alias, candidate.id, candidate.address].includes(value));
    return host ? validateHost({ ...options, ...host }) : parseTarget(value, options);
  }

  function connectionArgs(host: SshHostDefinition, copy: boolean): string[] {
    return [
      '-o', 'BatchMode=yes',
      ...(host.port === undefined ? [] : [copy ? '-P' : '-p', String(host.port)]),
      ...(host.identityFile === undefined ? [] : ['-i', host.identityFile]),
    ];
  }

  return {
    async listHosts(): Promise<readonly HostRecord[]> { return (options.hosts ?? []).map(host => record(validateHost(host))); },
    async resolve(host: string): Promise<HostRecord> { return record(definition(host)); },
    async exec(host, argv, commandOptions): Promise<HostExecResult> {
      validateArgv(argv);
      const target = definition(host);
      const result = await runHostCommand(exec, options.binary ?? 'ssh', [
        ...connectionArgs(target, false), '-T',
        ...(target.username === undefined ? [] : ['-l', target.username]),
        '--', target.address, argv.map(shellQuote).join(' '),
      ], commandOptions, result => result.code === 255 ? classifyHostFailure(result) : null);
      return toHostExecResult(result);
    },
    async upload(host, source, destination, commandOptions): Promise<void> {
      validatePath(source);
      validatePath(destination);
      const target = definition(host);
      const address = isIP(target.address) === 6 ? `[${target.address}]` : target.address;
      const remotePath = destination.startsWith('/') ? destination : `./${destination}`;
      await runHostCommand(exec, options.scpBinary ?? 'scp', [
        '-O', ...connectionArgs(target, true), '--', resolve(source),
        `${target.username ? `${target.username}@` : ''}${address}:${shellQuote(remotePath)}`,
      ], commandOptions, result => /scp: .*permission denied/i.test(result.stderr) ? 'remote-failed' : classifyHostFailure(result));
    },
  };
}
