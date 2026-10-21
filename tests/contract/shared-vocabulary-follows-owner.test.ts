import { describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';

/**
 * The shapes a workflow graph can be written in, and the results a QA
 * signal can carry, are vocabularies with one owner each. The command
 * that writes the graph, the command that writes the signal, and the
 * desktop that validates both must read the owner's list rather than
 * keeping their own.
 *
 * This test grows each vocabulary and then asks the entry points whether
 * they grew with it. An entry point that keeps its own copy refuses the
 * new value, and that refusal is the defect.
 */
vi.mock('@afk/execution', async importOriginal => {
  const original = await importOriginal<typeof import('@afk/execution')>();
  return {
    ...original,
    WORKFLOW_GRAPH_FORMATS: [...original.WORKFLOW_GRAPH_FORMATS, 'receipt'],
  };
});

vi.mock('@afk/core', async importOriginal => {
  const original = await importOriginal<typeof import('@afk/core')>();
  return {
    ...original,
    GOAL_COMPLETE_RESULTS: [...original.GOAL_COMPLETE_RESULTS, 'SKIP'],
  };
});

import { WORKFLOW_GRAPH_FORMATS } from '@afk/execution';
import { GOAL_COMPLETE_RESULTS } from '@afk/core';
import { registerGraphCommands } from '../../src/cli/commands/graph';
import { registerSignalCommands } from '../../src/cli/commands/signal';

vi.mock('@afk/execution/application/visualizations/workflow-graph', async importOriginal => {
  const original = await importOriginal<typeof import('@afk/execution/application/visualizations/workflow-graph')>();
  return {
    ...original,
    WORKFLOW_GRAPH_FORMATS: [...original.WORKFLOW_GRAPH_FORMATS, 'receipt'],
  };
});

describe('The entry points answer with the vocabularies their owners publish', () => {
  it('names every graph format the execution package declares', () => {
    const program = new Command();
    registerGraphCommands(program);
    const workflow = program.commands
      .find(command => command.name() === 'graph')
      ?.commands.find(command => command.name() === 'workflow');
    const format = workflow?.options.find(option => option.long === '--format');
    for (const value of WORKFLOW_GRAPH_FORMATS) {
      expect(format?.description).toContain(value);
    }
  });

  it('names every signal result the core package declares', () => {
    const program = new Command();
    registerSignalCommands(program);
    const signal = program.commands.find(command => command.name() === 'signal');
    const qaComplete = signal?.commands.find(command => command.name() === 'qa-complete');
    const result = qaComplete?.options.find(option => option.long === '--result');
    for (const value of GOAL_COMPLETE_RESULTS) {
      expect(result?.description).toContain(value);
    }
  });
});
