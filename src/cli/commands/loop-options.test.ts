import { Command } from 'commander';
import { describe, expect, it } from 'vitest';
import { addLoopStartOptions } from './loop-options.js';

describe('loop options', () => {
  it('parses numeric and manifest selection options', () => {
    const command = new Command();
    addLoopStartOptions(command);
    command.exitOverride();

    command.parse([
      'node',
      'afk',
      '--poll-interval',
      '4',
      '--backlog-id',
      '42',
      '--work-item-id',
      'github:org/repo#42',
      '--execution-manifest',
      '/workspace/manifest.json',
      '--template',
      'custom-workflow',
    ]);

    expect(command.opts()).toMatchObject({
      pollInterval: 4,
      backlogId: ['42'],
      workItemId: 'github:org/repo#42',
      executionManifest: '/workspace/manifest.json',
      template: 'custom-workflow',
    });
  });

  it('rejects non-positive numeric values', () => {
    const command = new Command();
    addLoopStartOptions(command);
    command.exitOverride();

    expect(() => command.parse(['node', 'afk', '--poll-interval', '0']))
      .toThrow();
  });
});
