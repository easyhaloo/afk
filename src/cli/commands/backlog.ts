import { Command } from 'commander';
import chalk from 'chalk';
import {
  createManagementProviders,
  type TrackerPlatform,
} from '../../application/tracker-provider-factory';
import {
  addBacklogTag,
  createBacklog,
  initializeBacklog,
  listBacklogs,
  removeBacklogTag,
  showBacklog,
  type BacklogManagementProvider,
} from '../../domain/backlog/commands';
import type { BacklogCreateInput, BacklogItem, BacklogState } from '../../domain/backlog';
import type { BacklogExecutionMode } from '../../domain/backlog';
import { handleCommandError, success, warning, detail } from '../cli-utils';
import {
  classifyError,
  emitFailure,
  emitSuccess,
} from '../json-output';

const states: BacklogState[] = ['ready', 'rework', 'in_progress', 'verification', 'merge_ready', 'done', 'blocked'];
const modes: BacklogExecutionMode[] = ['afk', 'hitl'];

function asPlatform(value: unknown): TrackerPlatform | undefined {
  return value === 'github' || value === 'gitlab' ? value : undefined;
}

function providerFor(project?: string, platform?: unknown): Promise<BacklogManagementProvider> {
  return createManagementProviders(project, undefined, asPlatform(platform)).then(bundle => bundle.backlog);
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

export type JsonMode = { json?: boolean };

/**
 * Action helper for `backlog list`. Emits the success envelope when
 * `options.json` is true; otherwise prints human-readable rows. Errors
 * route through `emitFailure` in JSON mode so callers can rely on the
 * structured protocol regardless of exit reason.
 */
export async function runBacklogList(
  provider: BacklogManagementProvider,
  options: { state?: string; mode?: string; tag?: string; parent?: string; project?: string; json?: boolean } = {},
): Promise<void> {
  const kind = 'backlog.list';
  try {
    if (options.state && !states.includes(options.state as BacklogState)) {
      throw new Error(`invalid backlog state: ${options.state}`);
    }
    if (options.mode && !modes.includes(options.mode as BacklogExecutionMode)) {
      throw new Error(`invalid execution mode: ${options.mode}`);
    }
    const items = await listBacklogs(provider, {
      state: options.state as BacklogState | undefined,
      executionMode: options.mode as BacklogExecutionMode | undefined,
      tag: options.tag,
      parentId: options.parent,
    });
    if (options.json) {
      emitSuccess<BacklogItem[]>(kind, items);
      return;
    }
    if (items.length === 0) { warning('No backlog items found'); return; }
    for (const item of items) printItem(item);
  } catch (error) {
    if (options.json) emitFailure(kind, classifyError(error), (error as Error).message);
    throw error;
  }
}

export async function runBacklogShow(
  provider: BacklogManagementProvider,
  id: string,
  options: JsonMode = {},
): Promise<void> {
  const kind = 'backlog.show';
  try {
    if (!id) throw new Error('backlog id is required');
    const item = await showBacklog(provider, id);
    if (options.json) {
      emitSuccess<BacklogItem>(kind, item);
      return;
    }
    printItem(item);
  } catch (error) {
    if (options.json) emitFailure(kind, classifyError(error), (error as Error).message);
    throw error;
  }
}

export async function runBacklogCreate(
  provider: BacklogManagementProvider,
  options: { title: string; descriptionFile?: string; parent?: string; baseBacklog?: string; dependsOn?: string[]; mode?: string; tag?: string[]; project?: string; json?: boolean } & { description?: string },
): Promise<void> {
  const kind = 'backlog.create';
  try {
    if (!options.title) throw new Error('backlog title is required');
    if (options.mode && !modes.includes(options.mode as BacklogExecutionMode)) {
      throw new Error(`invalid execution mode: ${options.mode}`);
    }
    const description = options.description ?? await readDescription(options.descriptionFile);
    if (!description.trim()) throw new Error('empty backlog description. Provide --description-file or pipe Markdown through stdin.');
    const input: BacklogCreateInput = {
      title: options.title,
      description,
      parentId: options.parent,
      baseBacklogId: options.baseBacklog,
      dependsOn: options.dependsOn,
      executionMode: options.mode as BacklogExecutionMode | undefined,
      tags: options.tag,
    };
    const item = await createBacklog(provider, input);
    if (options.json) {
      emitSuccess<BacklogItem>(kind, item);
      return;
    }
    if (!item.webUrl) throw new Error(`provider did not return a URL for created backlog ${item.id}`);
    success(`Created backlog ${item.id}: ${item.title}`);
    detail(`url: ${item.webUrl}`);
    if (item.parentId) detail(`parent: ${item.parentId}`);
    if (item.baseBacklogId) detail(`execution-base: ${item.baseBacklogId}`);
    if (item.dependsOn.length) detail(`depends-on: ${item.dependsOn.join(', ')}`);
  } catch (error) {
    if (options.json) emitFailure(kind, classifyError(error), (error as Error).message);
    throw error;
  }
}

export async function runBacklogTagAdd(
  provider: BacklogManagementProvider,
  id: string,
  tag: string,
  options: JsonMode = {},
): Promise<void> {
  const kind = 'backlog.tag.add';
  try {
    if (!id) throw new Error('backlog id is required');
    if (!tag) throw new Error('tag is required');
    await addBacklogTag(provider, id, tag);
    const item = await showBacklog(provider, id);
    if (options.json) {
      emitSuccess<BacklogItem>(kind, item);
      return;
    }
    success(`Tag added to backlog ${id}`);
  } catch (error) {
    if (options.json) emitFailure(kind, classifyError(error), (error as Error).message);
    throw error;
  }
}

export async function runBacklogTagRemove(
  provider: BacklogManagementProvider,
  id: string,
  tag: string,
  options: JsonMode = {},
): Promise<void> {
  const kind = 'backlog.tag.remove';
  try {
    if (!id) throw new Error('backlog id is required');
    if (!tag) throw new Error('tag is required');
    await removeBacklogTag(provider, id, tag);
    const item = await showBacklog(provider, id);
    if (options.json) {
      emitSuccess<BacklogItem>(kind, item);
      return;
    }
    success(`Tag removed from backlog ${id}`);
  } catch (error) {
    if (options.json) emitFailure(kind, classifyError(error), (error as Error).message);
    throw error;
  }
}

export function registerBacklogCommands(program: Command): void {
  const backlog = program.command('backlog').description('Manage and inspect backlog items (read/manage only)');

  backlog.command('init')
    .description('Initialize provider metadata for backlog state and mode')
    .option('--project <project>', 'Provider project/repository')
    .option('--platform <platform>', 'Override provider detection (github|gitlab)')
    .option('--json', 'Emit structured JSON envelope to stdout')
    .action(async options => {
      try {
        const provider = await providerFor(options.project, options.platform);
        if (options.json) {
          try {
            await initializeBacklog(provider);
            emitSuccess('backlog.init', { ok: true });
          } catch (error) {
            emitFailure('backlog.init', classifyError(error), (error as Error).message);
          }
          return;
        }
        await initializeBacklog(provider);
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
    .option('--platform <platform>', 'Override provider detection (github|gitlab)')
    .option('--json', 'Emit structured JSON envelope to stdout')
    .action(async options => {
      try {
        await runBacklogList(await providerFor(options.project, options.platform), options);
      } catch (error) { handleCommandError(error); }
    });

  backlog.command('show')
    .description('Show one backlog item')
    .requiredOption('--id <id>', 'Backlog ID')
    .option('--project <project>', 'Provider project/repository')
    .option('--platform <platform>', 'Override provider detection (github|gitlab)')
    .option('--json', 'Emit structured JSON envelope to stdout')
    .action(async options => {
      try {
        await runBacklogShow(await providerFor(options.project, options.platform), options.id, options);
      } catch (error) { handleCommandError(error); }
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
    .option('--platform <platform>', 'Override provider detection (github|gitlab)')
    .option('--json', 'Emit structured JSON envelope to stdout')
    .action(async (title: string, options) => {
      try {
        await runBacklogCreate(await providerFor(options.project, options.platform), { title, ...options });
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
    .option('--platform <platform>', 'Override provider detection (github|gitlab)')
    .option('--json', 'Emit structured JSON envelope to stdout')
    .action(async options => {
      try {
        await runBacklogTagAdd(await providerFor(options.project, options.platform), options.id, options.tag, options);
      } catch (error) { handleCommandError(error); }
    });

  tag.command('remove')
    .description('Remove a business tag')
    .requiredOption('--id <id>', 'Backlog ID')
    .requiredOption('--tag <tag>', 'Tag name')
    .option('--project <project>', 'Provider project/repository')
    .option('--platform <platform>', 'Override provider detection (github|gitlab)')
    .option('--json', 'Emit structured JSON envelope to stdout')
    .action(async options => {
      try {
        await runBacklogTagRemove(await providerFor(options.project, options.platform), options.id, options.tag, options);
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
