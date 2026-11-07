import { createJumpserverCli as createSharedJumpserverCli, execute, type JumpserverCliOptions } from '@afk/runtime/infrastructure/jms/jms-cli';

export {
  JUMPSERVER_BINARY_ERROR,
  type JumpserverAssetRow,
  type JumpserverCliOptions,
  type JumpserverServer,
} from '@afk/runtime/infrastructure/jms/jms-cli';
export type { JmsHostConnectionOptions, JmsTarget } from '@afk/runtime/infrastructure/jms/host-connection';
export { classifyJmsFailure, createJmsHostConnection } from '@afk/runtime/infrastructure/jms/host-connection';

export type JumpserverCommandResult = { ok: boolean; stdout: string; stderr: string };

export function createJumpserverCli(options: JumpserverCliOptions = {}) {
  const cli = createSharedJumpserverCli(options);
  const exec = options.exec ?? execute;
  return {
    ...cli,
    async execCommand(target: string, command: string): Promise<JumpserverCommandResult> {
      const result = await exec('jms', ['exec', target, command]);
      return { ok: result.ok, stdout: result.stdout.trim(), stderr: result.stderr };
    },
    async uploadFile(localPath: string, target: string, remoteDirectory: string): Promise<{ ok: boolean; stderr: string }> {
      const directory = remoteDirectory.endsWith('/') ? remoteDirectory : remoteDirectory + '/';
      const result = await exec('jms', ['sftp', localPath, target + ':' + directory]);
      return { ok: result.ok, stderr: result.stderr };
    },
  };
}
