import { promises as fs, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { RunEvent, RunEventDraft, AppendReceipt, EventChainIntegrity, EventStorePort } from '@afk/core';
import { replay } from '@afk/core';
import { signEvent, verifyEventChain } from './event-chain.js';

export class EventStoreCorruptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EventStoreCorruptionError';
  }
}

export interface JsonlEventStoreOptions {
  root?: string;
  now?: () => Date;
}

/**
 * Durable local event store for a single AFK workspace. It serializes concurrent
 * writes in-process and fsyncs each append. A future LeasePort-backed adapter
 * will add cross-process fencing without changing EventStorePort.
 */
export class JsonlEventStore implements EventStorePort {
  readonly root: string;
  private readonly now: () => Date;
  private readonly mutations = new Map<string, Promise<void>>();

  constructor(options: JsonlEventStoreOptions = {}) {
    // One rule for every entry point: an explicit root wins, then
    // AFK_EVENT_STORE_DIR, then the home directory. The desktop used to
    // hard-code the home directory while the CLI honoured the environment
    // variable, so a run started with a custom root wrote its audit trail
    // where the desktop was not looking.
    this.root = options.root ?? process.env.AFK_EVENT_STORE_DIR ?? join(homedir(), '.afk', 'events');
    this.now = options.now ?? (() => new Date());
  }

  async append(drafts: readonly RunEventDraft[]): Promise<AppendReceipt> {
    if (drafts.length === 0) throw new Error('cannot append an empty event batch');
    const runId = drafts[0].context.runId;
    if (!runId) throw new Error('event runId is required');
    if (drafts.some(draft => draft.context.runId !== runId)) throw new Error('all events in a batch must share a runId');

    return this.mutate(runId, async () => {
      const existing = await this.load(runId);
      let previous = existing.at(-1);
      const observedAt = this.now().toISOString();
      const events = drafts.map((draft, index) => {
        const event = signEvent({
          ...draft,
          sequence: existing.length + index + 1,
          observedAt,
        }, previous);
        previous = event;
        return event;
      });
      await fs.mkdir(this.root, { recursive: true });
      const handle = await fs.open(this.pathFor(runId), 'a', 0o600);
      try {
        await handle.writeFile(`${events.map(event => JSON.stringify(event)).join('\n')}\n`, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      return {
        runId,
        firstSequence: events[0].sequence,
        lastSequence: events.at(-1)!.sequence,
        lastHash: events.at(-1)!.integrity.hash,
      };
    });
  }

  async *read(runId: string, options: { afterSequence?: number } = {}): AsyncIterable<RunEvent> {
    for (const event of await this.load(runId)) {
      if (event.sequence > (options.afterSequence ?? 0)) yield event;
    }
  }

  async listRuns(): Promise<readonly string[]> {
    let names: string[];
    try {
      names = await fs.readdir(this.root);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    return names
      .filter(name => name.endsWith('.jsonl'))
      .map(name => Buffer.from(name.slice(0, -'.jsonl'.length), 'base64url').toString('utf8'))
      .filter(Boolean)
      .sort((left, right) => left.localeCompare(right));
  }

  async verify(runId: string): Promise<EventChainIntegrity> {
    try {
      return verifyEventChain(runId, await this.load(runId));
    } catch (error) {
      return { valid: false, lastSequence: 0, reason: error instanceof Error ? error.message : 'unknown_error' };
    }
  }

  /**
   * The signature of what this store holds for a run.
   *
   * The file's identity and its timestamps change when the run's events
   * change, and a reader that caches a projection of the run can tell from
   * this whether its copy is still the truth. The file's name is this
   * store's own business; a reader never has to know it.
   */
  async revision(runId: string): Promise<string | undefined> {
    try {
      const stat = await fs.stat(this.pathFor(runId));
      return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
    } catch {
      return undefined;
    }
  }

  /** Where a reader may keep a cache of this store's contents. */
  cacheDirectory(): string {
    return this.root;
  }

  async prune(options: { retentionMs?: number; exclusiveAccess?: boolean } = {}): Promise<readonly string[]> {
    if (options.retentionMs === undefined) return [];
    if (!Number.isSafeInteger(options.retentionMs) || options.retentionMs < 0) {
      throw new Error('retentionMs must be a non-negative safe integer');
    }
    if (options.exclusiveAccess !== true) return [];
    const cutoff = this.now().getTime() - options.retentionMs;
    if (!Number.isFinite(cutoff)) throw new Error('retention cutoff must be a valid time');
    const pruned: string[] = [];
    for (const runId of await this.listRuns()) {
      let pruningTail: Promise<void> | undefined;
      const pruning = this.mutate(runId, async () => {
        try {
          if (!(await this.verify(runId)).valid) return false;
          const events = await this.load(runId);
          const last = events.at(-1);
          if (last?.data.kind !== 'run.finished' || !['succeeded', 'failed', 'cancelled'].includes(last.data.outcome)) return false;
          if (!events.every(event => event.schemaVersion === 1 && event.type === event.data.kind && typeof event.occurredAt === 'string'
            && Number.isFinite(Date.parse(event.occurredAt)) && Date.parse(event.occurredAt) < cutoff)) return false;
          if (!replay(events)?.terminal) return false;
          if (this.mutations.get(runId) !== pruningTail) return false;
          unlinkSync(this.pathFor(runId));
          return true;
        } catch {
          return false;
        }
      });
      pruningTail = this.mutations.get(runId);
      if (await pruning) pruned.push(runId);
    }
    return pruned;
  }

  private async load(runId: string): Promise<RunEvent[]> {
    let text: string;
    try {
      text = await fs.readFile(this.pathFor(runId), 'utf8');
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const lines = text.split('\n').filter(Boolean);
    return lines.map((line, index) => {
      try {
        const event = JSON.parse(line) as RunEvent;
        if (!event || typeof event !== 'object' || typeof event.sequence !== 'number' || !event.integrity?.hash) {
          throw new Error('invalid event shape');
        }
        return event;
      } catch (error) {
        throw new EventStoreCorruptionError(`cannot parse event ${index + 1} for run '${runId}': ${error instanceof Error ? error.message : 'unknown error'}`);
      }
    });
  }

  private pathFor(runId: string): string {
    return join(this.root, `${Buffer.from(runId, 'utf8').toString('base64url')}.jsonl`);
  }

  private async mutate<T>(runId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.mutations.get(runId) ?? Promise.resolve();
    const result = previous.then(operation);
    const tail = result.then(() => undefined, () => undefined);
    this.mutations.set(runId, tail);
    try {
      return await result;
    } finally {
      if (this.mutations.get(runId) === tail) this.mutations.delete(runId);
    }
  }
}
