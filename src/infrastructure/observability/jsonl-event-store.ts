import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { RunEvent, RunEventDraft } from '../../core/events';
import type { AppendReceipt, EventStorePort } from '../../core/ports';

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
    this.root = options.root ?? join(homedir(), '.afk', 'events');
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
        const event = sign({
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

  async verify(runId: string): Promise<{ valid: boolean; lastSequence: number; lastHash?: string; reason?: string }> {
    let previous: RunEvent | undefined;
    let count = 0;
    try {
      for (const event of await this.load(runId)) {
        count += 1;
        if (event.context.runId !== runId) return { valid: false, lastSequence: count - 1, lastHash: previous?.integrity.hash, reason: 'run_id_mismatch' };
        if (event.sequence !== count) return { valid: false, lastSequence: count - 1, lastHash: previous?.integrity.hash, reason: 'sequence_gap' };
        if (!verify(event, previous)) return { valid: false, lastSequence: count - 1, lastHash: previous?.integrity.hash, reason: 'integrity_mismatch' };
        previous = event;
      }
      return { valid: true, lastSequence: count, lastHash: previous?.integrity.hash };
    } catch (error) {
      return { valid: false, lastSequence: count, lastHash: previous?.integrity.hash, reason: error instanceof Error ? error.message : 'unknown_error' };
    }
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

function sign(draft: RunEventDraft & { sequence: number; observedAt: string }, previous?: RunEvent): RunEvent {
  const integrity = { prevHash: previous?.integrity.hash };
  const hash = createHash('sha256').update(stableJson({ ...draft, integrity })).digest('hex');
  return { ...draft, integrity: { ...integrity, hash } } as RunEvent;
}

function verify(event: RunEvent, previous?: RunEvent): boolean {
  if (previous?.integrity.hash !== event.integrity.prevHash) return false;
  const { integrity: _integrity, ...draft } = event;
  const expected = sign(draft, previous);
  return expected.integrity.hash === event.integrity.hash;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (!value || typeof value !== 'object') return JSON.stringify(value);
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
}
