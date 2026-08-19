import { Command } from 'commander';
import { describe, expect, it } from 'vitest';
import { addLoopStartOptions } from './loop-options';

describe('loop options', () => {
  it('parses numeric and variadic options with their intended types', () => {
    const command = new Command();
    addLoopStartOptions(command);
    command.exitOverride();

    command.parse([
      'node',
      'afk',
      '--max-concurrent',
      '4',
      '--ext',
      'isolate',
      '--ext-param',
      'isolate.auto=true',
    ]);

    expect(command.opts()).toMatchObject({
      maxConcurrent: 4,
      ext: ['isolate'],
      extParam: ['isolate.auto=true'],
    });
  });

  it('rejects non-positive numeric values', () => {
    const command = new Command();
    addLoopStartOptions(command);
    command.exitOverride();

    expect(() => command.parse(['node', 'afk', '--max-concurrent', '0']))
      .toThrow();
  });
});
