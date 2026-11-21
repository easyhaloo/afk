import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DayRotator, dayLog, fileLogger, getLogContext, logger, resolveLogPath, withLogContext, withLogWriteFailureObserver, type LogContext } from './logger.js';
import { promises as fs, openSync, closeSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RunObserver } from '../../observability/run-observer.js';
import { JsonlEventStore } from '../observability/jsonl-event-store.js';
import { createRunObserver } from '../observability/run-observer-factory.js';

const lines: Array<Partial<LogContext> & { msg: string }> = [];
const originalLevel = logger.level;
const directories: string[] = [];
const originalLogDir = process.env.AFK_LOG_DIR;

beforeEach(() => {
  lines.length = 0;
  vi.spyOn(dayLog, 'write').mockImplementation(chunk => {
    lines.push(JSON.parse(String(chunk)));
    return true;
  });
  logger.level = 'info';
  fileLogger.level = 'info';
});

afterEach(async () => {
  logger.level = originalLevel;
  fileLogger.level = originalLevel;
  vi.restoreAllMocks();
  if (originalLogDir === undefined) delete process.env.AFK_LOG_DIR;
  else process.env.AFK_LOG_DIR = originalLogDir;
  await Promise.all(directories.splice(0).map(path => fs.rm(path, { recursive: true, force: true })));
});

async function nativeLogFixture() {
  vi.mocked(dayLog.write).mockRestore();
  const root = await fs.mkdtemp(join(tmpdir(), 'd10-native-log-'));
  directories.push(root);
  const blocked = join(root, 'PRIVATE_PATH_CANARY');
  await fs.writeFile(blocked, 'not a directory');
  process.env.AFK_LOG_DIR = blocked;
  const events = new JsonlEventStore({ root: join(root, 'events') });
  const context = { traceId: 't', runId: 'native', workItemId: 'github:org/repo#1', profileId: 'local', attempt: 1, actor: { kind: 'cli' as const, id: 'test' } };
  return { root, events, context };
}

describe('native day-log failure accounting', () => {
  it('retains the original append error when an exporter warning also hits a real native log failure', async () => {
    const { root, context } = await nativeLogFixture();
    const original = new Error('ORIGINAL_SOURCE_APPEND');
    const append = vi.spyOn(JsonlEventStore.prototype, 'append').mockRejectedValue(original);
    const warning = vi.spyOn(logger, 'warn');
    await expect(createRunObserver(join(root, 'events'), [{ provider: {
      id: 'tracing', capabilities: { span: true }, startSpan: async () => { throw new Error('EXPORT_CANARY'); }, endSpan: async () => undefined,
    }, signals: ['tracing'] }]).record(context, { kind: 'qa.passed' })).rejects.toBe(original);
    expect(append).toHaveBeenCalledTimes(1);
    expect(warning).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warning.mock.calls)).not.toContain('CANARY');
  });

  it('observes real writeSync failures with fixed facts and keeps the stream usable even if observation throws', async () => {
    const { root } = await nativeLogFixture();
    const path = join(root, 'read-only-descriptor');
    await fs.writeFile(path, 'native write must fail');
    const descriptor = openSync(path, 'r');
    const stream = new DayRotator();
    // Supply a real read-only descriptor to exercise writeSync, independently of openSync failures.
    Object.assign(stream, { fd: descriptor, current: resolveLogPath() });
    const observed = vi.fn(() => { throw new Error('OBSERVER_CANARY'); });
    const errors = vi.fn();
    stream.on('error', errors);
    try {
      await withLogWriteFailureObserver(observed, async () => {
        expect(() => stream.write('first')).not.toThrow();
        expect(() => stream.write('second')).not.toThrow();
      });
      expect(observed.mock.calls).toEqual([[], []]);
      expect(errors).not.toHaveBeenCalled();
      expect(stream.destroyed).toBe(false);
    } finally { closeSync(descriptor); }
  });

  it('restores nested failure observers on rejection and ignores late writes after an operation closes', async () => {
    await nativeLogFixture();
    const parent = vi.fn();
    const child = vi.fn();
    let late!: () => void;
    const ready = new Promise<void>(resolve => { late = resolve; });
    let pending!: Promise<void>;
    const original = new Error('ORIGINAL_OPERATION');
    await withLogWriteFailureObserver(parent, async () => {
      await expect(withLogWriteFailureObserver(child, async () => {
        logger.info('child');
        pending = ready.then(() => { logger.info('late child'); });
        throw original;
      })).rejects.toBe(original);
      logger.info('parent');
      late();
      await pending;
    });
    logger.info('outside');
    expect(child).toHaveBeenCalledTimes(1);
    expect(parent).toHaveBeenCalledTimes(1);
  });

  it('persists repeated real default logger open failures without throwing or leaking paths', async () => {
    const { events, context } = await nativeLogFixture();
    const observer = new RunObserver({ events });
    await expect(observer.record(context, { kind: 'qa.passed' })).resolves.toMatchObject({ lastSequence: 1 });
    await expect(observer.record(context, { kind: 'qa.passed' })).resolves.toMatchObject({ lastSequence: 3 });
    const history = [];
    for await (const event of events.read(context.runId)) history.push(event);
    const summaries = history.filter(event => event.data.kind === 'effect.completed' && event.data.effectKind === 'observability.delivery');
    expect(summaries).toHaveLength(2);
    for (const event of summaries) expect(JSON.parse(event.data.kind === 'effect.completed' ? event.data.summary! : '{}'))
      .toMatchObject({ dayRotatorWriteFailures: 1, counts: { logging: { failed: 1 } }, retry: 'none' });
    expect(JSON.stringify(history)).not.toContain('CANARY');
    expect(await events.verify(context.runId)).toMatchObject({ valid: true, lastSequence: 4 });
  });

  it('isolates a suspended failing record from a concurrent healthy record and restores the scope', async () => {
    const { root, events, context } = await nativeLogFixture();
    let release!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    let suspended = false;
    const observer = new RunObserver({ events, onPersisted: async draft => {
      if (draft.context.runId === context.runId) { suspended = true; await waiting; }
    } });
    const first = observer.record(context, { kind: 'qa.passed' });
    await vi.waitFor(() => expect(suspended).toBe(true));
    process.env.AFK_LOG_DIR = join(root, 'healthy');
    await observer.record({ ...context, runId: 'healthy' }, { kind: 'qa.passed' });
    release();
    await first;
    const all = async (runId: string) => { const records = []; for await (const event of events.read(runId)) records.push(event); return records; };
    expect(await all('healthy')).toHaveLength(1);
    const failing = await all(context.runId);
    expect(failing).toHaveLength(2);
    expect(JSON.parse(failing[1].data.kind === 'effect.completed' ? failing[1].data.summary! : '{}').dayRotatorWriteFailures).toBe(1);
    process.env.AFK_LOG_DIR = join(root, 'PRIVATE_PATH_CANARY');
    expect(() => logger.info('outside record')).not.toThrow();
    expect(await all(context.runId)).toEqual(failing);
  });

  it('does not close a reused business descriptor after a failed rotation open', async () => {
    const { root } = await nativeLogFixture();
    process.env.AFK_LOG_DIR = join(root, 'healthy');
    logger.info('open day file');
    process.env.AFK_LOG_DIR = join(root, 'PRIVATE_PATH_CANARY');
    logger.info('failed rotation');
    const business = openSync(join(root, 'business-audit'), 'a');
    try {
      logger.info('retry failed rotation');
      expect(() => writeSync(business, 'audit remains writable')).not.toThrow();
    } finally { try { closeSync(business); } catch {} }
  });
});

describe('log context', () => {
  it('isolates concurrent async scopes in logger and fileLogger and preserves redaction', async () => {
    let releaseFirst!: () => void;
    const firstWaiting = new Promise<void>(resolve => { releaseFirst = resolve; });
    const first = withLogContext({ runId: 'managed-a', workItemId: '191' }, async () => {
      logger.info('a-start');
      await firstWaiting;
      expect(getLogContext()).toEqual({ runId: 'managed-a', workItemId: '191' });
      fileLogger.info({ token: 'private-a', nested: { password: 'private-b' } }, 'a-end');
      return 'result-a';
    });
    const second = withLogContext({ runId: 'managed-b', workItemId: '192' }, async () => {
      await Promise.resolve();
      expect(getLogContext()).toEqual({ runId: 'managed-b', workItemId: '192' });
      fileLogger.info({ phase: 'qa' }, 'b');
      releaseFirst();
    });
    expect((await Promise.all([first, second]))[0]).toBe('result-a');
    expect(lines.map(({ msg, runId, workItemId }) => ({ msg, runId, workItemId }))).toEqual([
      { msg: 'a-start', runId: 'managed-a', workItemId: '191' },
      { msg: 'b', runId: 'managed-b', workItemId: '192' },
      { msg: 'a-end', runId: 'managed-a', workItemId: '191' },
    ]);
    expect(lines[2]).toMatchObject({ token: '[redacted]', nested: { password: '[redacted]' } });
    expect(lines[1]).toHaveProperty('phase', 'qa');
    expect(lines[0]).not.toHaveProperty('phase');
    expect(getLogContext()).toBeUndefined();
    logger.info('outside');
    expect(lines[3]).not.toHaveProperty('runId');
    expect(lines[3]).not.toHaveProperty('workItemId');
  });

  it('lets QA reuse the managed run context and restores the parent scope after errors', async () => {
    await withLogContext({ runId: 'managed', workItemId: '191' }, async () => {
      const managed = getLogContext()!;
      await withLogContext(managed, async () => {
        await Promise.resolve();
        fileLogger.info('qa');
      });
      await expect(withLogContext({ runId: 'child', workItemId: '192' }, async () => {
        await Promise.resolve();
        throw new Error('qa failed');
      })).rejects.toThrow('qa failed');
      expect(getLogContext()).toEqual(managed);
      logger.info('managed-after-qa');
    });
    expect(lines.map(line => line.runId)).toEqual(['managed', 'managed']);
    expect(getLogContext()).toBeUndefined();
  });
});

describe('error serialization', () => {
  it('keeps the message of errors logged under the `error` key', () => {
    // simple-git errors carry only enumerable own props (`config`), so an
    // unserialized `error` key hides message/stack and the real cause.
    class GitConstructError extends Error {
      constructor(readonly config: { baseDir: string }) {
        super('Cannot use simple-git on a directory that does not exist');
        this.name = 'GitConstructError';
      }
    }
    fileLogger.error({ error: new GitConstructError({ baseDir: '/gone' }) }, 'QA execution failed');
    expect(lines[0]).toMatchObject({
      msg: 'QA execution failed',
      error: {
        type: 'GitConstructError',
        message: 'Cannot use simple-git on a directory that does not exist',
      },
    });
  });
});
