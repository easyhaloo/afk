import { Command } from 'commander';
import chalk from 'chalk';
import { createManagementProviderBundle } from '../lib/client-factory';
import {
  addBacklogTag,
  initializeBacklog,
  listBacklogs,
  removeBacklogTag,
  showBacklog,
  type BacklogManagementProvider,
} from '../lib/backlog/commands';
import type { BacklogExecutionMode, BacklogState } from '../lib/core/backlog';
import { handleCommandError, success, warning, detail } from '../lib/cli-utils';

const states: BacklogState[] = ['ready', 'in_progress', 'verification', 'merge_ready', 'done', 'blocked'];
const modes: BacklogExecutionMode[] = ['afk', 'hitl'];

function providerFor(project?: string): Promise<BacklogManagementProvider> {
  return createManagementProviderBundle(project).then(bundle => bundle.backlog);
}

function printItem(item: Awaited<ReturnType<typeof showBacklog>>): void {
  console.log(`${chalk.bold(item.id)}  ${item.title}`);
  detail(`state: ${item.state}  mode: ${item.executionMode}`);
  if (item.parentId) detail(`parent: ${item.parentId}`);
  if (item.dependsOn.length) detail(`depends-on: ${item.dependsOn.join(', ')}`);
  if (item.tags.length) detail(`tags: ${item.tags.join(', ')}`);
  detail(`branch: ${item.branchName}`);
}

export function registerBacklogCommands(program: Command): void {
  const backlog = program
    .command('backlog')
    .description('Manage and inspect backlog items (read/manage only)');

  backlog
    .command('init')
    .description('Initialize provider metadata for backlog state and mode')
    .option('--project <project>', 'Provider project/repository')
    .action(async options => {
      try {
        await initializeBacklog(await providerFor(options.project));
        success('Backlog provider initialized');
      } catch (error) {
        handleCommandError(error);
      }
    });

  backlog
    .command('list')
    .description('List backlog items')
    .option('--state <state>', `Filter by state (${states.join('|')})`)
    .option('--mode <mode>', `Filter by execution mode (${modes.join('|')})`)
    .option('--tag <tag>', 'Filter by business tag')
    .option('--parent <id>', 'Filter by parent backlog ID')
    .option('--project <project>', 'Provider project/repository')
    .action(async options => {
      try {
        if (options.state && !states.includes(options.state)) throw new Error(`invalid backlog state: ${options.state}`);
        if (options.mode && !modes.includes(options.mode)) throw new Error(`invalid execution mode: ${options.mode}`);
        const items = await listBacklogs(await providerFor(options.project), {
          state: options.state,
          executionMode: options.mode,
          tag: options.tag,
          parentId: options.parent,
        });
        if (items.length === 0) {
          warning('No backlog items found');
          return;
        }
        for (const item of items) printItem(item);
      } catch (error) {
        handleCommandError(error);
      }
    });

  backlog
    .command('show')
    .description('Show one backlog item')
    .requiredOption('--id <id>', 'Backlog ID')
    .option('--project <project>', 'Provider project/repository')
    .action(async options => {
      try {
        printItem(await showBacklog(await providerFor(options.project), options.id));
      } catch (error) {
        handleCommandError(error);
      }
    });

  const tag = backlog.command('tag').description('Manage business tags on a backlog item');
  tag
    .command('add')
    .description('Add a business tag')
    .requiredOption('--id <id>', 'Backlog ID')
    .requiredOption('--tag <tag>', 'Tag name')
    .option('--project <project>', 'Provider project/repository')
    .action(async options => {
      try {
        await addBacklogTag(await providerFor(options.project), options.id, options.tag);
        success(`Tag added to backlog ${options.id}`);
      } catch (error) {
        handleCommandError(error);
      }
    });

  tag
    .command('remove')
    .description('Remove a business tag')
    .requiredOption('--id <id>', 'Backlog ID')
    .requiredOption('--tag <tag>', 'Tag name')
    .option('--project <project>', 'Provider project/repository')
    .action(async options => {
      try {
        await removeBacklogTag(await providerFor(options.project), options.id, options.tag);
        success(`Tag removed from backlog ${options.id}`);
      } catch (error) {
        handleCommandError(error);
      }
    });

  backlog.action(() => backlog.outputHelp());
}
