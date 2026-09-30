import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { loadLoopConfig } from '../../application/loop/loop-config';
import { registerLoopCommands, resolveManagedLoopExecution } from './loop';
import { registerRunCommands } from './run';
import { registerQACommands } from './qa';
import { Command } from 'commander';

const CONFIG_DIR = path.join('/tmp', `afk-loop-config-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
const CONFIG_PATH = path.join(CONFIG_DIR, '.afk', 'config.yml');

describe('loadLoopConfig', () => {
  let cwdSpy: any;

  beforeEach(() => {
    // Create the .afk dir
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    // Mock process.cwd to return our temp dir
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(CONFIG_DIR);
  });

  afterEach(() => {
    cwdSpy?.mockRestore();
    try { fs.rmSync(CONFIG_DIR, { recursive: true, force: true }); } catch { /* */ }
  });

  it('returns empty moduleTriggers when no config file exists', () => {
    // Remove the config file if it exists
    try { fs.unlinkSync(CONFIG_PATH); } catch { /* */ }
    const result = loadLoopConfig();
    expect(result.moduleTriggers).toEqual({});
  });

  it('parses a single module trigger', () => {
    fs.writeFileSync(CONFIG_PATH, `loop:
  module_triggers:
    need::isolate: [isolate]
`, 'utf-8');
    const result = loadLoopConfig();
    expect(result.moduleTriggers).toEqual({ 'need::isolate': ['isolate'] });
  });

  it('parses multiple module triggers', () => {
    fs.writeFileSync(CONFIG_PATH, `loop:
  module_triggers:
    need::isolate: [isolate]
    need::mock: [mock-server]
`, 'utf-8');
    const result = loadLoopConfig();
    expect(result.moduleTriggers).toEqual({
      'need::isolate': ['isolate'],
      'need::mock': ['mock-server'],
    });
  });

  it('parses multiple modules for a single label', () => {
    fs.writeFileSync(CONFIG_PATH, `loop:
  module_triggers:
    need::fork: [fork, mock-server]
`, 'utf-8');
    const result = loadLoopConfig();
    expect(result.moduleTriggers).toEqual({ 'need::fork': ['fork', 'mock-server'] });
  });

  it('handles empty config file gracefully', () => {
    fs.writeFileSync(CONFIG_PATH, '', 'utf-8');
    const result = loadLoopConfig();
    expect(result.moduleTriggers).toEqual({});
  });

  it('handles config without module_triggers section', () => {
    fs.writeFileSync(CONFIG_PATH, `workflow:
  modules:
    - isolate
`, 'utf-8');
    const result = loadLoopConfig();
    expect(result.moduleTriggers).toEqual({});
  });

  it('handles empty module_triggers section gracefully', () => {
    fs.writeFileSync(CONFIG_PATH, `loop:
  module_triggers:
`, 'utf-8');
    const result = loadLoopConfig();
    // No label entries under module_triggers → empty
    expect(result.moduleTriggers).toEqual({});
  });
});

describe('loop option parsing', () => {
  it('accepts the explicit managed work item and manifest flags on both loop entries', () => {
    const program = new Command().exitOverride();
    registerLoopCommands(program);
    const loop = program.commands.find(command => command.name() === 'loop')!;
    for (const command of [loop, loop.commands.find(child => child.name() === 'start')!]) {
      expect(command.options.map(option => option.long)).toEqual(expect.arrayContaining(['--work-item-id', '--execution-manifest']));
    }
    expect(resolveManagedLoopExecution({ backlogId: ['42'], workItemId: 'github:org/repo#42', executionManifest: '/workspace/manifest.json' })).toEqual({
      workItemId: 'github:org/repo#42', manifestPath: '/workspace/manifest.json',
    });
  });

  it.each([
    { workItemId: 'github:org/repo#42' },
    { executionManifest: '/workspace/manifest.json' },
    { backlogId: ['42', '43'], workItemId: 'github:org/repo#42', executionManifest: '/workspace/manifest.json' },
    { backlogId: ['42'], workItemId: '42', executionManifest: '/workspace/manifest.json' },
    {},
  ])('rejects ambiguous managed loop selection %j', options => {
    expect(() => resolveManagedLoopExecution(options)).toThrow();
  });

  it('rejects configured module triggers instead of silently ignoring them', () => {
    expect(() => resolveManagedLoopExecution({
      backlogId: ['42'], workItemId: 'github:org/repo#42', executionManifest: '/workspace/manifest.json',
    }, { 'need::isolate': ['isolate'] })).toThrow(/module triggers/);
  });

  it('does not expose options for the removed execution chain', () => {
    const program = new Command().exitOverride();
    registerLoopCommands(program);
    const loop = program.commands.find(command => command.name() === 'loop')!;
    for (const command of [loop, loop.commands.find(child => child.name() === 'start')!]) {
      expect(command.options.map(option => option.long)).not.toContain('--agent');
      expect(command.options.map(option => option.long)).not.toContain('--ext');
      expect(command.options.map(option => option.long)).not.toContain('--agent-transport');
    }
  });

  it('parses repeated backlog scope values', () => {
    const program = new Command().exitOverride();
    registerLoopCommands(program);
    const loop = program.commands.find(command => command.name() === 'loop')!;
    const scope = loop.options.find(option => option.long === '--backlog-id')!;

    expect(scope.parseArg?.('114', [])).toEqual(['114']);
    expect(scope.parseArg?.('115', ['114'])).toEqual(['114', '115']);
  });

  it('keeps Codex runtime overrides on run and qa, not on the manifest-bound loop', () => {
    const program = new Command().exitOverride();
    registerRunCommands(program);
    registerLoopCommands(program);
    registerQACommands(program);
    const commands = [
      program.commands.find(command => command.name() === 'run')!,
      program.commands.find(command => command.name() === 'qa')!,
    ];
    const expected = [
      '--agent-transport', '--agent-auth', '--agent-provider', '--agent-profile',
      '--agent-app-server', '--agent-app-server-auth-env',
    ];

    for (const command of commands) {
      expect(expected.every(flag => command.options.some(option => option.long === flag))).toBe(true);
    }
    const transport = commands[0].options.find(option => option.long === '--agent-transport')!;
    expect(transport.parseArg?.('app-server', undefined)).toBe('app-server');
    expect(() => transport.parseArg?.('remote', undefined)).toThrow(/transport/i);
  });
});
