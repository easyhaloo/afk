import { describe, expect, it } from 'vitest';
import { buildLazyArgv } from './lazy-loader';

describe('buildLazyArgv', () => {
  it('removes the parent command before parsing a nested subcommand', () => {
    expect(buildLazyArgv('backlog', ['create', 'Expected title'], 'create')).toEqual([
      'afk', 'create', 'Expected title',
    ]);
  });

  it('keeps the matched command for direct command parsing', () => {
    expect(buildLazyArgv('run', ['--backlog-id', '42'])).toEqual([
      'afk', 'run', '--backlog-id', '42',
    ]);
  });
});
