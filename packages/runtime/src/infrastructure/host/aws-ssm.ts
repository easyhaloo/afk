import { setTimeout as delay } from 'node:timers/promises';
import type { HostExecResult, HostRecord } from '@afk/core';
import { HostFailure } from '@afk/core';
import { z } from 'zod';
import {
  createHostCommandExecutor, parseJson, runHostCommand, shellQuote, validateArgv, validateTimeout,
  type CancellableHostConnection, type HostCommandExecutor, type HostCommandOptions,
} from './command.js';

export interface AwsSsmHostDefinition {
  readonly id?: string;
  readonly alias: string;
  readonly instanceId: string;
  readonly region?: string;
  readonly profile?: string;
  readonly address?: string;
}

export interface AwsSsmHostConnectionOptions {
  readonly hosts?: readonly AwsSsmHostDefinition[];
  readonly region?: string;
  readonly profile?: string;
  readonly binary?: string;
  readonly exec?: HostCommandExecutor;
  readonly pollIntervalMs?: number;
}

const managedNodes = z.object({ InstanceInformationList: z.array(z.object({
  InstanceId: z.string().min(1), ComputerName: z.string().optional(), IPAddress: z.string().optional(),
  PlatformType: z.enum(['Windows', 'Linux', 'MacOS']),
})) });
const sentCommand = z.object({ Command: z.object({ CommandId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9-]*$/) }) });
const invocation = z.object({
  Status: z.enum(['Pending', 'InProgress', 'Delayed', 'Cancelling', 'Success', 'Cancelled', 'TimedOut', 'Failed']),
  ResponseCode: z.number().int().min(-1).optional(),
  StandardOutputContent: z.string().optional(), StandardErrorContent: z.string().optional(),
});

function record(host: AwsSsmHostDefinition): HostRecord {
  return { id: host.id ?? host.instanceId, alias: host.alias, address: host.address, provider: 'aws-ssm' };
}

export function createAwsSsmHostConnection(options: AwsSsmHostConnectionOptions = {}): CancellableHostConnection {
  const exec = options.exec ?? createHostCommandExecutor();
  const binary = options.binary ?? 'aws';
  const pollIntervalMs = options.pollIntervalMs ?? 1000;
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs < 0 || pollIntervalMs > 2147483647) {
    throw new HostFailure('remote-failed', 'invalid SSM pollIntervalMs');
  }

  function awsArgs(args: readonly string[], host?: AwsSsmHostDefinition): string[] {
    const region = host?.region ?? options.region;
    const profile = host?.profile ?? options.profile;
    return [
      ...args, '--output', 'json', '--no-cli-pager',
      ...(region === undefined ? [] : [`--region=${region}`]),
      ...(profile === undefined ? [] : [`--profile=${profile}`]),
    ];
  }

  async function discover(commandOptions?: HostCommandOptions): Promise<AwsSsmHostDefinition[]> {
    const response = await runHostCommand(exec, binary, awsArgs(['ssm', 'describe-instance-information']), commandOptions);
    const data = parseJson(response.stdout, 'aws ssm describe-instance-information', managedNodes);
    return data.InstanceInformationList.filter(node => node.PlatformType !== 'Windows').map(node => ({
      alias: node.ComputerName || node.InstanceId, instanceId: node.InstanceId, address: node.IPAddress,
    }));
  }

  async function definition(host: string, commandOptions?: HostCommandOptions): Promise<AwsSsmHostDefinition> {
    const find = (hosts: readonly AwsSsmHostDefinition[]) => hosts.find(candidate => [candidate.alias, candidate.id, candidate.instanceId, candidate.address].includes(host));
    const configured = find(options.hosts ?? []);
    const target = configured ?? (/^(i|mi)-[a-f0-9]+$/.test(host) ? { alias: host, instanceId: host } : find(await discover(commandOptions)));
    if (!target || !/^(i|mi)-[a-f0-9]+$/.test(target.instanceId)) {
      throw new HostFailure('asset-unknown', `SSM managed node "${host}" was not found or has an invalid id`);
    }
    return target;
  }

  return {
    async listHosts(): Promise<readonly HostRecord[]> { return (options.hosts ?? await discover()).map(record); },
    async resolve(host: string): Promise<HostRecord> { return record(await definition(host)); },
    async exec(host, argv, commandOptions = {}): Promise<HostExecResult> {
      validateArgv(argv);
      const timeoutMs = validateTimeout(commandOptions.timeoutMs);
      const deadline = Date.now() + timeoutMs;
      const remaining = (): HostCommandOptions => {
        if (commandOptions.signal?.aborted) throw new HostFailure('unreachable', 'AWS SSM command cancelled');
        const timeLeft = deadline - Date.now();
        if (timeLeft <= 0) throw new HostFailure('unreachable', 'AWS SSM command timed out');
        return { timeoutMs: timeLeft, signal: commandOptions.signal };
      };
      const target = await definition(host, remaining());
      const send = await runHostCommand(exec, binary, awsArgs([
        'ssm', 'send-command', '--instance-ids', target.instanceId,
        '--document-name', 'AWS-RunShellScript', '--parameters', JSON.stringify({
          commands: [argv.map(shellQuote).join(' ')], executionTimeout: [String(Math.max(1, Math.ceil(timeoutMs / 1000)))],
        }),
      ], target), remaining());
      const { Command: { CommandId: commandId } } = parseJson(send.stdout, 'aws ssm send-command', sentCommand);
      let terminal = false;
      try {
        while (true) {
          let data: z.infer<typeof invocation> | undefined;
          try {
            const response = await runHostCommand(exec, binary, awsArgs([
              'ssm', 'get-command-invocation', '--command-id', commandId, '--instance-id', target.instanceId,
            ], target), remaining());
            remaining();
            data = parseJson(response.stdout, 'aws ssm get-command-invocation', invocation);
          } catch (error) {
            if (!(error instanceof HostFailure) || !/InvocationDoesNotExist/.test(error.message)) throw error;
          }
          if (data && ['Success', 'Cancelled', 'TimedOut', 'Failed'].includes(data.Status)) {
            terminal = true;
            if (!['Success', 'Failed'].includes(data.Status) || data.ResponseCode === undefined || data.ResponseCode < 0 ||
              (data.Status === 'Success' && data.ResponseCode !== 0) || (data.Status === 'Failed' && data.ResponseCode === 0)) {
              throw new HostFailure(data.Status === 'TimedOut' ? 'unreachable' : 'remote-failed',
                `AWS SSM command ${data.Status} (exit ${data.ResponseCode ?? 'unknown'}): ${data.StandardErrorContent ?? ''}`.trim());
            }
            if (typeof data.StandardOutputContent !== 'string' || typeof data.StandardErrorContent !== 'string') {
              throw new HostFailure('remote-failed', 'AWS SSM success response is missing command output');
            }
            return { code: data.ResponseCode, stdout: data.StandardOutputContent, stderr: data.StandardErrorContent };
          }
          const budget = remaining();
          try {
            await delay(Math.min(Math.max(1, pollIntervalMs), budget.timeoutMs!), undefined, { signal: budget.signal });
          } catch (error) {
            throw new HostFailure('unreachable', 'AWS SSM command cancelled', { cause: error });
          }
        }
      } catch (error) {
        if (!terminal) {
          try {
            await runHostCommand(exec, binary, awsArgs([
              'ssm', 'cancel-command', '--command-id', commandId, '--instance-ids', target.instanceId,
            ], target), { timeoutMs: 5000 });
          } catch (cancelError) {
            throw new HostFailure(error instanceof HostFailure ? error.code : 'remote-failed',
              `${error instanceof Error ? error.message : 'SSM command failed'}; remote cancellation failed for ${commandId}`,
              { cause: new AggregateError([error, cancelError]) });
          }
        }
        throw error;
      }
    },
  };
}
