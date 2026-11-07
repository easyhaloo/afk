import { resolve } from 'node:path';
import type { HostExecResult, HostRecord } from '@afk/core';
import { HostFailure } from '@afk/core';
import { z } from 'zod';
import {
  classifyHostFailure, createHostCommandExecutor, parseJson, runHostCommand, toHostExecResult,
  validateArgv, validatePath, type CancellableHostConnection, type HostCommandExecutor,
} from './command.js';

export interface KubernetesHostDefinition {
  readonly id?: string;
  readonly alias: string;
  readonly pod: string;
  readonly namespace?: string;
  readonly container?: string;
  readonly address?: string;
}

export interface KubernetesExecConnectionOptions {
  readonly hosts?: readonly KubernetesHostDefinition[];
  readonly namespace?: string;
  readonly context?: string;
  readonly kubeconfig?: string;
  readonly binary?: string;
  readonly exec?: HostCommandExecutor;
}

const podList = z.object({ items: z.array(z.object({
  metadata: z.object({ name: z.string().min(1), namespace: z.string().min(1) }),
  status: z.object({ podIP: z.string().optional() }).optional(),
})) });

function resourceName(value: string, label: string): string {
  if (value.length > 253 || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(value)) {
    throw new HostFailure('asset-unknown', `invalid Kubernetes ${label}`);
  }
  return value;
}

export function createKubernetesExecHostConnection(options: KubernetesExecConnectionOptions = {}): CancellableHostConnection {
  const exec = options.exec ?? createHostCommandExecutor();
  const binary = options.binary ?? 'kubectl';
  const defaultNamespace = resourceName(options.namespace ?? 'default', 'namespace');

  function args(argv: readonly string[]): string[] {
    return [
      ...(options.context === undefined ? [] : [`--context=${options.context}`]),
      ...(options.kubeconfig === undefined ? [] : [`--kubeconfig=${options.kubeconfig}`]),
      ...argv,
    ];
  }

  function validate(host: KubernetesHostDefinition): KubernetesHostDefinition {
    resourceName(host.pod, 'pod');
    resourceName(host.namespace ?? defaultNamespace, 'namespace');
    if (host.container !== undefined) resourceName(host.container, 'container');
    return host;
  }

  function record(host: KubernetesHostDefinition): HostRecord {
    return { id: host.id ?? `${host.namespace ?? defaultNamespace}/${host.pod}`, alias: host.alias, address: host.address, provider: 'kubernetes-exec' };
  }

  async function discover(): Promise<KubernetesHostDefinition[]> {
    const response = await runHostCommand(exec, binary, args(['get', 'pods', `--namespace=${defaultNamespace}`, '-o', 'json']));
    return parseJson(response.stdout, 'kubectl get pods', podList).items.map(item => validate({
      alias: `${item.metadata.namespace}/${item.metadata.name}`, pod: item.metadata.name,
      namespace: item.metadata.namespace, address: item.status?.podIP,
    }));
  }

  function definition(value: string): KubernetesHostDefinition {
    const configured = options.hosts?.find(candidate => [candidate.alias, candidate.id, `${candidate.namespace ?? defaultNamespace}/${candidate.pod}`].includes(value)
      || (candidate.pod === value && (candidate.namespace ?? defaultNamespace) === defaultNamespace));
    if (configured) return validate(configured);
    const parts = value.split('/');
    if (parts.length > 2) throw new HostFailure('asset-unknown', 'Kubernetes target must be pod or namespace/pod');
    return validate({ alias: value, pod: parts.at(-1)!, namespace: parts.length === 2 ? parts[0] : defaultNamespace });
  }

  return {
    async listHosts(): Promise<readonly HostRecord[]> { return (options.hosts ?? await discover()).map(host => record(validate(host))); },
    async resolve(host: string): Promise<HostRecord> { return record(definition(host)); },
    async exec(host, argv, commandOptions): Promise<HostExecResult> {
      validateArgv(argv);
      const target = definition(host);
      const result = await runHostCommand(exec, binary, args([
        'exec', `--namespace=${target.namespace ?? defaultNamespace}`, target.pod,
        ...(target.container === undefined ? [] : [`--container=${target.container}`]), '--', ...argv,
      ]), commandOptions, result => {
        const remoteExit = result.stderr.match(/command terminated with (?:non-zero )?exit code (\d+)\s*$/i);
        if (remoteExit) return Number(remoteExit[1]) === result.code ? null : 'remote-failed';
        return /executable file not found|exec .*no such file/i.test(result.stderr) ? 'remote-failed' : classifyHostFailure(result);
      });
      return toHostExecResult(result);
    },
    async upload(host, source, destination, commandOptions): Promise<void> {
      validatePath(source);
      validatePath(destination);
      if (destination.includes(':')) throw new HostFailure('remote-failed', 'kubectl cp destination must not contain a colon');
      const target = definition(host);
      const path = destination.startsWith('/') ? destination : `./${destination}`;
      await runHostCommand(exec, binary, args([
        'cp', `--namespace=${target.namespace ?? defaultNamespace}`,
        ...(target.container === undefined ? [] : [`--container=${target.container}`]), '--',
        resolve(source), `${target.pod}:${path}`,
      ]), commandOptions);
    },
  };
}
