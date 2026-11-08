import type { Plugin } from './runtime.js';
import { createJumpserverCli } from '../../infrastructure/jms/jms-cli.js';
import { createJmsHostConnection, type JmsHostConnectionOptions } from '../../infrastructure/jms/host-connection.js';

export function createJumpserverPlugin(options: JmsHostConnectionOptions = {}): Plugin {
  const cli = options.cli ?? createJumpserverCli(options);
  const connection = createJmsHostConnection({ ...options, cli });
  return {
    manifest: {
      id: 'host.jumpserver',
      version: '0.1.0',
      apiVersion: 1,
      provides: ['host.connection'],
      trusted: true,
    },
    activate(context) {
      context.registerHostProvider('jumpserver', connection);
    },
    async health() {
      const binary = await cli.resolveBinaryPath();
      return binary
        ? { status: 'healthy', details: { binary } }
        : { status: 'degraded', message: 'jms CLI not found on PATH' };
    },
  };
}
