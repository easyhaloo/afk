/**
 * DockerContainerProvider — thin engine-specific subclass of CliContainerProvider.
 * Docker shares the run/exec/kill/rm/inspect CLI with Podman; this file only
 * sets engine metadata and the binary name (`docker`).
 */

import { CliContainerProvider } from './cli-provider.js';
import type { ContainerEngine } from './types.js';

export class DockerContainerProvider extends CliContainerProvider {
  readonly engine: ContainerEngine = 'docker';
  readonly binary = 'docker';

  async isAvailable(): Promise<boolean> {
    return this.probeVersion('{{.Server.Version}}');
  }
}
