import type { HostConnectionPort, HostExecResult, HostRecord } from '@afk/core';

export interface HostApplication {
  listHosts(): Promise<readonly HostRecord[]>;
  exec(input: { host: string; argv: readonly string[]; timeoutMs?: number }): Promise<HostExecResult>;
}

export function createHostApplication(connection: HostConnectionPort): HostApplication {
  return {
    listHosts: () => connection.listHosts(),
    exec: async input => {
      if (input.argv.length === 0) throw new Error('host exec requires at least one argument');
      return connection.exec(input.host, input.argv, { timeoutMs: input.timeoutMs });
    },
  };
}
