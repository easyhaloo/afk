/**
 * PodmanContainerProvider — rootless-friendly variant of CliContainerProvider.
 * Podman shares the docker CLI for run/exec/kill/rm/inspect (the podman CLI
 * was deliberately designed as a drop-in replacement for the subset we use).
 */

import { spawn } from 'child_process';
import { CliContainerProvider } from './cli-provider';
import type { ContainerEngine } from './types';

export class PodmanContainerProvider extends CliContainerProvider {
  readonly engine: ContainerEngine = 'podman';
  readonly binary = 'podman';

  async isAvailable(): Promise<boolean> {
    return new Promise(resolve => {
      const child = spawn(this.binary, ['version', '--format', '{{.Version}}'], { stdio: ['ignore', 'pipe', 'ignore'] });
      let out = '';
      child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString('utf-8')));
      child.on('error', () => resolve(false));
      child.on('close', code => resolve(code === 0 && out.trim().length > 0));
    });
  }
}