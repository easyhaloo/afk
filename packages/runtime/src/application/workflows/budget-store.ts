import { workspaceDataDirectory } from '../../infrastructure/workspace.js';
import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

export interface BudgetSnapshot {
  version: 1;
  workItemKey: string;
  used: number;
  tokens: number;
  sessions: Record<string, number>;
}

export class BudgetStoreCorruptionError extends Error {
  constructor(path: string, cause: unknown) {
    super(`budget ledger is corrupt: ${path}`, { cause });
    this.name = 'BudgetStoreCorruptionError';
  }
}

export class BudgetStore {
  private readonly path: string;

  constructor(root: string, private readonly workItemKey: string) {
    this.path = join(workspaceDataDirectory(root), 'budgets', `${encodeURIComponent(workItemKey)}.json`);
  }

  async load(): Promise<BudgetSnapshot | undefined> {
    let raw: string;
    try {
      raw = await fs.readFile(this.path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    try {
      const value = JSON.parse(raw) as Partial<BudgetSnapshot>;
      if (
        value.version !== 1 ||
        value.workItemKey !== this.workItemKey ||
        typeof value.used !== 'number' || !Number.isSafeInteger(value.used) || value.used < 0 ||
        typeof value.tokens !== 'number' || !Number.isSafeInteger(value.tokens) || value.tokens < 0 ||
        !value.sessions || typeof value.sessions !== 'object' || Array.isArray(value.sessions) ||
        Object.entries(value.sessions).some(([id, tokens]) => !id || !Number.isSafeInteger(tokens) || tokens < 0) ||
        Object.values(value.sessions).reduce((total, tokens) => total + tokens, 0) !== value.tokens
      ) throw new Error('invalid budget snapshot');
      return { version: 1, workItemKey: value.workItemKey, used: value.used, tokens: value.tokens, sessions: value.sessions };
    } catch (error) {
      throw new BudgetStoreCorruptionError(this.path, error);
    }
  }

  async save(snapshot: Omit<BudgetSnapshot, 'version' | 'workItemKey'>): Promise<void> {
    const envelope: BudgetSnapshot = { version: 1, workItemKey: this.workItemKey, ...snapshot };
    await fs.mkdir(dirname(this.path), { recursive: true });
    const tempPath = `${this.path}.${randomUUID()}.tmp`;
    try {
      const handle = await fs.open(tempPath, 'wx', 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(envelope)}\n`, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fs.rename(tempPath, this.path);
    } finally {
      await fs.rm(tempPath, { force: true });
    }
  }
}
