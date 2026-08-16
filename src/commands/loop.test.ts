import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { loadLoopConfig } from './loop';
import { registerLoopCommands } from './loop';
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
  it('keeps provider and module option values as strings', () => {
    const program = new Command().exitOverride();
    registerLoopCommands(program);
    const loop = program.commands.find(command => command.name() === 'loop')!;
    const agent = loop.options.find(option => option.long === '--agent')!;
    const ext = loop.options.find(option => option.long === '--ext')!;

    expect(agent.parseArg).toBeUndefined();
    expect(ext.parseArg).toBeUndefined();
  });

  it('exposes the same Codex runtime overrides on run, loop, loop start, and qa', () => {
    const program = new Command().exitOverride();
    registerRunCommands(program);
    registerLoopCommands(program);
    registerQACommands(program);
    const loop = program.commands.find(command => command.name() === 'loop')!;
    const commands = [
      program.commands.find(command => command.name() === 'run')!,
      loop,
      loop.commands.find(command => command.name() === 'start')!,
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
