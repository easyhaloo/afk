import { describe, expect, it } from 'vitest';
import { buildLazyArgv, lazyLoad } from './lazy-loader';

describe('buildLazyArgv', () => {
  it('removes the parent command before parsing a nested subcommand', () => {
    expect(buildLazyArgv('backlog', ['create', 'Expected title'], 'create')).toEqual([
      'afk', 'create', 'Expected title',
    ]);
  });

  it('preserves deeper backlog tag subcommands for Commander routing', () => {
    expect(buildLazyArgv('backlog', ['tag', 'add', '--id', '42', '--tag', 'urgent'], 'tag')).toEqual([
      'afk', 'tag', 'add', '--id', '42', '--tag', 'urgent',
    ]);
    expect(buildLazyArgv('backlog', ['tag', 'remove', '--id', '42', '--tag', 'urgent'], 'tag')).toEqual([
      'afk', 'tag', 'remove', '--id', '42', '--tag', 'urgent',
    ]);
  });

  it('routes observe subcommands through the matched observe command', () => {
    expect(buildLazyArgv('observe', ['timeline', 'run-42', '--json'], 'timeline')).toEqual([
      'afk', 'timeline', 'run-42', '--json',
    ]);
  });

  it('keeps the matched command for direct command parsing', () => {
    expect(buildLazyArgv('run', ['--backlog-id', '42'])).toEqual([
      'afk', 'run', '--backlog-id', '42',
    ]);
  });

  it.each([
    ['backlog', ['tag', 'add', '--help'], 'Add a business tag'],
    ['backlog', ['tag', 'remove', '--help'], 'Remove a business tag'],
    ['observe', ['timeline', '--help'], 'Show ordered audit events for a run'],
  ] as const)('executes the real lazy nested parser for %s %j', async (command, args, expectedHelp) => {
    const captured: string[] = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: string | Uint8Array): boolean => {
      captured.push(typeof chunk === 'string' ? chunk : chunk.toString());
      return true;
    };
    try {
      await expect(lazyLoad(command, [...args])).rejects.toMatchObject({ code: 'commander.helpDisplayed' });
    } finally {
      process.stdout.write = originalWrite;
    }
    expect(captured.join('')).toContain(expectedHelp);
  });
});
