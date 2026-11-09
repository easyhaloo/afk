import type { Plugin } from './runtime.js';
import { createAwsSsmHostConnection, type AwsSsmHostConnectionOptions } from '../../infrastructure/host/aws-ssm.js';
import { createKubernetesExecHostConnection, type KubernetesExecConnectionOptions } from '../../infrastructure/host/kubernetes-exec.js';
import { createSshHostConnection, type SshHostConnectionOptions } from '../../infrastructure/host/ssh.js';

export function createSshPlugin(options: SshHostConnectionOptions = {}): Plugin {
  const provider = createSshHostConnection(options);
  return {
    manifest: { id: 'host.ssh', version: '0.1.0', apiVersion: 1, provides: ['host.connection'], trusted: true },
    activate(context) { context.registerHostProvider('ssh', provider); },
  };
}

export function createAwsSsmPlugin(options: AwsSsmHostConnectionOptions = {}): Plugin {
  const provider = createAwsSsmHostConnection(options);
  return {
    manifest: { id: 'host.aws-ssm', version: '0.1.0', apiVersion: 1, provides: ['host.connection'], trusted: true },
    activate(context) { context.registerHostProvider('aws-ssm', provider); },
  };
}

export function createKubernetesExecPlugin(options: KubernetesExecConnectionOptions = {}): Plugin {
  const provider = createKubernetesExecHostConnection(options);
  return {
    manifest: { id: 'host.kubernetes-exec', version: '0.1.0', apiVersion: 1, provides: ['host.connection'], trusted: true },
    activate(context) { context.registerHostProvider('kubernetes-exec', provider); },
  };
}

export function createHostPlugins(options?: {
  readonly ssh?: SshHostConnectionOptions;
  readonly awsSsm?: AwsSsmHostConnectionOptions;
  readonly kubernetes?: KubernetesExecConnectionOptions;
}): readonly Plugin[] {
  return [
    createSshPlugin(options?.ssh),
    createAwsSsmPlugin(options?.awsSsm),
    createKubernetesExecPlugin(options?.kubernetes),
  ];
}
