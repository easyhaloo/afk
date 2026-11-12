import { CandidateStore } from './candidate-store.js';
import { createRequire } from 'node:module';
import { requireNodeSqlite, type SqliteDatabase } from '../../infrastructure/storage/sqlite.js';
import type { CandidateState } from './contracts.js';
import type { EvidencePack } from './evidence.js';

const store = new CandidateStore({ file: process.argv[2]! });
process.send?.('ready');
process.on('message', (message: { action: 'submit' | 'complete' | 'scan' | 'transition' | 'reserve'; input: never;
  key?: string; id?: string; version?: number; state?: CandidateState; pauseBeforeCommit?: boolean; snapshot?: EvidencePack }) => {
  try {
    if (message.pauseBeforeCommit) {
      const { DatabaseSync } = requireNodeSqlite<{ DatabaseSync: { prototype: SqliteDatabase } }>(createRequire(import.meta.url));
      const execute = DatabaseSync.prototype.exec;
      DatabaseSync.prototype.exec = function (sql) {
        if (sql === 'COMMIT') { process.send?.('before-commit'); process.kill(process.pid, 'SIGSTOP'); }
        return execute.call(this, sql);
      };
    }
    const result = message.action === 'submit' ? store.submitRequest(message.input, message.snapshot)
      : message.action === 'scan' ? store.commitScan(message.input)
        : message.action === 'reserve' ? store.reserveModelCall(message.input)
        : message.action === 'transition' ? store.transitionCandidate(message.id!, message.version!, message.state!)
          : store.completeRequest(message.key!, message.input);
    process.send?.({ result });
  } catch (error) {
    process.send?.({ error: (error as Error).message });
  }
});
