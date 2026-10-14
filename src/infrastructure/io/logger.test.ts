import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dayLog, fileLogger, getLogContext, logger, withLogContext, type LogContext } from './logger.js';

const lines: Array<Partial<LogContext> & { msg: string }> = [];
const originalLevel = logger.level;

beforeEach(() => {
  lines.length = 0;
  vi.spyOn(dayLog, 'write').mockImplementation(chunk => {
    lines.push(JSON.parse(String(chunk)));
    return true;
  });
  logger.level = 'info';
  fileLogger.level = 'info';
});

afterEach(() => {
  logger.level = originalLevel;
  fileLogger.level = originalLevel;
  vi.restoreAllMocks();
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
