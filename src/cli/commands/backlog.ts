import { Command } from 'commander';
import chalk from 'chalk';
import { createManagementProviders } from '../../application/tracker-provider-factory';
import {
  addBacklogTag,
  createBacklog,
  initializeBacklog,
  listBacklogs,
  removeBacklogTag,
  showBacklog,
  type BacklogManagementProvider,
} from '../../domain/backlog/commands';
import type { BacklogExecutionMode, BacklogState } from '../../domain/backlog';
import { handleCommandError, success, warning, detail } from '../cli-utils';

const states: BacklogState[] = ['ready', 'rework', 'in_progress', 'verification', 'merge_ready', 'done', 'blocked'];
const modes: BacklogExecutionMode[] = ['afk', 'hitl'];

function providerFor(project?: string): Promise<BacklogManagementProvider> {
  return createManagementProviders(project).then(bundle => bundle.backlog);
}

function printItem(item: Awaited<ReturnType<typeof showBacklog>>): void {
  console.log(`${chalk.bold(item.id)}  ${item.title}`);
  detail(`state: ${item.state}  mode: ${item.executionMode}`);
  if (item.parentId) detail(`parent: ${item.parentId}`);
  if (item.baseBacklogId) detail(`execution-base: ${item.baseBacklogId}`);
  if (item.dependsOn.length) detail(`depends-on: ${item.dependsOn.join(', ')}`);
  if (item.tags.length) detail(`tags: ${item.tags.join(', ')}`);
  detail(`branch: ${item.branchName}`);
}

export function registerBacklogCommands(program: Command): void {
  const backlog = program.command('backlog').description('Manage and inspect backlog items (read/manage only)');

  backlog.command('init')
    .description('Initialize provider metadata for backlog state and mode')
    .option('--project <project>', 'Provider project/repository')
    .action(async options => {
      try {
        await initializeBacklog(await providerFor(options.project));
        success('Backlog provider initialized');
      } catch (error) { handleCommandError(error); }
    });

  backlog.command('list')
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
        if (items.length === 0) { warning('No backlog items found'); return; }
        for (const item of items) printItem(item);
      } catch (error) { handleCommandError(error); }
    });

  backlog.command('show')
    .description('Show one backlog item')
    .requiredOption('--id <id>', 'Backlog ID')
    .option('--project <project>', 'Provider project/repository')
    .action(async options => {
      try { printItem(await showBacklog(await providerFor(options.project), options.id)); }
      catch (error) { handleCommandError(error); }
    });

  backlog
    .command('create')
    .description('Create one provider-backed backlog item')
    .argument('<title>', 'Backlog title')
    .option('--description-file <path>', 'Markdown description file (defaults to stdin)')
    .option('--parent <id>', 'Organizational parent backlog ID (does not select a git base branch)')
    .option('--base-backlog <id>', 'Backlog ID whose unmerged branch is the explicit execution base')
    .option('-d, --depends-on <id>', 'Backlog ID that must complete first', (value: string, previous: string[]) => [...previous, value], [])
    .option('--mode <mode>', `Execution mode (${modes.join('|')})`, 'afk')
    .option('--tag <tag>', 'Business tag', (value: string, previous: string[]) => [...previous, value], [])
    .option('--project <project>', 'Provider project/repository')
    .action(async (title: string, options) => {
      try {
        if (!modes.includes(options.mode)) throw new Error(`invalid execution mode: ${options.mode}`);
        const description = await readDescription(options.descriptionFile);
        if (!description.trim()) throw new Error('empty backlog description. Provide --description-file or pipe Markdown through stdin.');
        const item = await createBacklog(await providerFor(options.project), {
          title,
          description,
          parentId: options.parent,
          baseBacklogId: options.baseBacklog,
          dependsOn: options.dependsOn,
          executionMode: options.mode,
          tags: options.tag,
        });
        if (!item.webUrl) throw new Error(`provider did not return a URL for created backlog ${item.id}`);
        success(`Created backlog ${item.id}: ${item.title}`);
        detail(`url: ${item.webUrl}`);
        if (item.parentId) detail(`parent: ${item.parentId}`);
        if (item.baseBacklogId) detail(`execution-base: ${item.baseBacklogId}`);
        if (item.dependsOn.length) detail(`depends-on: ${item.dependsOn.join(', ')}`);
      } catch (error) {
        handleCommandError(error);
      }
    });

  const tag = backlog.command('tag').description('Manage business tags on a backlog item');
  tag.command('add')
    .description('Add a business tag')
    .requiredOption('--id <id>', 'Backlog ID')
    .requiredOption('--tag <tag>', 'Tag name')
    .option('--project <project>', 'Provider project/repository')
    .action(async options => {
      try {
        await addBacklogTag(await providerFor(options.project), options.id, options.tag);
        success(`Tag added to backlog ${options.id}`);
      } catch (error) { handleCommandError(error); }
    });

  tag.command('remove')
    .description('Remove a business tag')
    .requiredOption('--id <id>', 'Backlog ID')
    .requiredOption('--tag <tag>', 'Tag name')
    .option('--project <project>', 'Provider project/repository')
    .action(async options => {
      try {
        await removeBacklogTag(await providerFor(options.project), options.id, options.tag);
        success(`Tag removed from backlog ${options.id}`);
      } catch (error) { handleCommandError(error); }
    });

  backlog.action(() => backlog.outputHelp());
}

async function readDescription(path?: string): Promise<string> {
  const { readFile } = await import('node:fs/promises');
  if (path) return readFile(path, 'utf8');
  if (!process.stdin.isTTY) return readFile('/dev/stdin', 'utf8');
  return '';
}
