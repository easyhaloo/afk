/**
 * DockerContainerProvider — thin engine-specific subclass of CliContainerProvider.
 * Docker shares the run/exec/kill/rm/inspect CLI with Podman; this file only
 * sets engine metadata and the binary name (`docker`).
 */

import { spawn } from 'child_process';
import { CliContainerProvider } from './cli-provider';
import type { ContainerEngine } from './types';

export class DockerContainerProvider extends CliContainerProvider {
  readonly engine: ContainerEngine = 'docker';
  readonly binary = 'docker';

  async isAvailable(): Promise<boolean> {
    return new Promise(resolve => {
      const child = spawn(this.binary, ['version', '--format', '{{.Server.Version}}'], { stdio: ['ignore', 'pipe', 'ignore'] });
      let out = '';
      child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString('utf-8')));
      child.on('error', () => resolve(false));
      child.on('close', code => resolve(code === 0 && out.trim().length > 0));
    });
  }
}