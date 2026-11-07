/**
 * PodmanContainerProvider — rootless-friendly variant of CliContainerProvider.
 * Podman shares the docker CLI for run/exec/kill/rm/inspect (the podman CLI
 * was deliberately designed as a drop-in replacement for the subset we use).
 */

import { CliContainerProvider } from './cli-provider.js';
import type { ContainerEngine } from './types.js';

export class PodmanContainerProvider extends CliContainerProvider {
  readonly engine: ContainerEngine = 'podman';
  readonly binary = 'podman';

  async isAvailable(): Promise<boolean> {
    return this.probeVersion('{{.Version}}');
  }
}
