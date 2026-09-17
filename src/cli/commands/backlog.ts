import { Command } from 'commander';
import chalk from 'chalk';
import {
  createManagementProviders,
  type TrackerPlatform,
} from '../../application/tracker-provider-factory';
import {
  addBacklogTag,
  confirmBacklogMerge,
  createBacklog,
  initializeBacklog,
  interruptBacklog,
  listBacklogs,
  removeBacklogTag,
  retryBacklog,
  showBacklog,
  type BacklogChangeProvider,
  type BacklogManagementProvider,
} from '../../domain/backlog/commands';
import type { BacklogCreateInput, BacklogItem, BacklogState, QABacklogProvider } from '../../domain/backlog';
import type { BacklogExecutionMode } from '../../domain/backlog';
import { getWorkflowConfig } from '../../infrastructure/config/manager';
import { handleCommandError, success, warning, detail } from '../cli-utils';
import type { CommandRegistrationContext } from '../command-registry';
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

function isHelpError(error: { code?: string; exitCode?: number }): boolean {
  return error.exitCode === 0 || error.code === 'commander.help' || error.code === 'commander.helpDisplayed';
}

function hasBacklogJsonArgs(argv: readonly string[]): boolean {
  return argv.includes('--json') && argv.includes('backlog');
}

function configureBacklogJsonErrors(command: Command, kind: string, argv: readonly string[]): void {
  command.exitOverride(error => {
    if (hasBacklogJsonArgs(argv) && !isHelpError(error)) {
      emitFailure(kind, 'validation', error.message);
    }
    throw error;
  });
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
    if (options.json) {
      emitFailure(kind, classifyError(error), (error as Error).message);
      return;
    }
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
    if (options.json) {
      emitFailure(kind, classifyError(error), (error as Error).message);
      return;
    }
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
    if (options.json) {
      emitFailure(kind, classifyError(error), (error as Error).message);
      return;
    }
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
    if (options.json) {
      emitFailure(kind, classifyError(error), (error as Error).message);
      return;
    }
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
    if (options.json) {
      emitFailure(kind, classifyError(error), (error as Error).message);
      return;
    }
    throw error;
  }
}

export async function runBacklogInterrupt(
  provider: QABacklogProvider,
  id: string,
  reason: string,
  options: JsonMode = {},
): Promise<void> {
  await runLifecycleAction('backlog.interrupt', options, () => interruptBacklog(provider, id, reason), `Backlog ${id} interrupted`);
}

export async function runBacklogRetry(
  provider: QABacklogProvider,
  id: string,
  reason: string,
  options: JsonMode = {},
): Promise<void> {
  await runLifecycleAction('backlog.retry', options, () => retryBacklog(provider, id, reason), `Backlog ${id} queued for rework`);
}

export async function runBacklogConfirmMerge(
  provider: QABacklogProvider,
  changes: BacklogChangeProvider,
  id: string,
  expectedTargetBranch: string,
  options: JsonMode = {},
): Promise<void> {
  await runLifecycleAction('backlog.confirm-merge', options, () => confirmBacklogMerge(provider, changes, id, expectedTargetBranch), `Backlog ${id} merged and completed`);
}

async function runLifecycleAction(
  kind: string,
  options: JsonMode,
  action: () => Promise<BacklogItem>,
  message: string,
): Promise<void> {
  try {
    const item = await action();
    if (options.json) {
      emitSuccess<BacklogItem>(kind, item);
      return;
    }
    success(message);
  } catch (error) {
    if (options.json) {
      emitFailure(kind, classifyError(error), (error as Error).message);
      return;
    }
    throw error;
  }
}

export function registerBacklogCommands(program: Command, context: CommandRegistrationContext = {}): void {
  const argv = context.argv ?? process.argv;
  const inheritedOutput = program.configureOutput();
  const inheritedOutputError = inheritedOutput.outputError;
  program.configureOutput({
    outputError: (message, write) => {
      if (!hasBacklogJsonArgs(argv)) {
        if (inheritedOutputError) inheritedOutputError(message, write);
        else write(message);
      }
    },
  });
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
      } catch (error) {
        if (options.json) {
          emitFailure('backlog.init', classifyError(error), (error as Error).message);
          return;
        }
        handleCommandError(error);
      }
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
      } catch (error) {
        if (options.json) {
          emitFailure('backlog.list', classifyError(error), (error as Error).message);
          return;
        }
        handleCommandError(error);
      }
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
      } catch (error) {
        if (options.json) {
          emitFailure('backlog.show', classifyError(error), (error as Error).message);
          return;
        }
        handleCommandError(error);
      }
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
        if (options.json) {
          emitFailure('backlog.create', classifyError(error), (error as Error).message);
          return;
        }
        handleCommandError(error);
      }
    });

  backlog.command('interrupt')
    .description('Stop active execution and hand the backlog to an operator')
    .requiredOption('--id <id>', 'Backlog ID')
    .requiredOption('--reason <text>', 'Interruption reason')
    .option('--project <project>', 'Provider project/repository')
    .option('--platform <platform>', 'Override provider detection (github|gitlab)')
    .option('--json', 'Emit structured JSON envelope to stdout')
    .action(async options => {
      try {
        const providers = await createManagementProviders(options.project, undefined, asPlatform(options.platform));
        await runBacklogInterrupt(providers.backlog, options.id, options.reason, options);
      } catch (error) {
        if (options.json) {
          emitFailure('backlog.interrupt', classifyError(error), (error as Error).message);
          return;
        }
        handleCommandError(error);
      }
    });

  backlog.command('retry')
    .description('Return blocked operator-owned work to autonomous rework')
    .requiredOption('--id <id>', 'Backlog ID')
    .requiredOption('--reason <text>', 'Retry reason')
    .option('--project <project>', 'Provider project/repository')
    .option('--platform <platform>', 'Override provider detection (github|gitlab)')
    .option('--json', 'Emit structured JSON envelope to stdout')
    .action(async options => {
      try {
        const providers = await createManagementProviders(options.project, undefined, asPlatform(options.platform));
        await runBacklogRetry(providers.backlog, options.id, options.reason, options);
      } catch (error) {
        if (options.json) {
          emitFailure('backlog.retry', classifyError(error), (error as Error).message);
          return;
        }
        handleCommandError(error);
      }
    });

  backlog.command('confirm-merge')
    .description('Merge an approved root backlog change and mark it done')
    .requiredOption('--id <id>', 'Backlog ID')
    .option('--project <project>', 'Provider project/repository')
    .option('--platform <platform>', 'Override provider detection (github|gitlab)')
    .option('--json', 'Emit structured JSON envelope to stdout')
    .action(async options => {
      try {
        const providers = await createManagementProviders(options.project, undefined, asPlatform(options.platform));
        await runBacklogConfirmMerge(providers.backlog, providers.changes, options.id, getWorkflowConfig().targetBranch, options);
      } catch (error) {
        if (options.json) {
          emitFailure('backlog.confirm-merge', classifyError(error), (error as Error).message);
          return;
        }
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
      } catch (error) {
        if (options.json) {
          emitFailure('backlog.tag.add', classifyError(error), (error as Error).message);
          return;
        }
        handleCommandError(error);
      }
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
      } catch (error) {
        if (options.json) {
          emitFailure('backlog.tag.remove', classifyError(error), (error as Error).message);
          return;
        }
        handleCommandError(error);
      }
    });

  configureBacklogJsonErrors(backlog.commands.find(command => command.name() === 'init')!, 'backlog.init', argv);
  configureBacklogJsonErrors(backlog.commands.find(command => command.name() === 'list')!, 'backlog.list', argv);
  configureBacklogJsonErrors(backlog.commands.find(command => command.name() === 'show')!, 'backlog.show', argv);
  configureBacklogJsonErrors(backlog.commands.find(command => command.name() === 'create')!, 'backlog.create', argv);
  configureBacklogJsonErrors(backlog.commands.find(command => command.name() === 'interrupt')!, 'backlog.interrupt', argv);
  configureBacklogJsonErrors(backlog.commands.find(command => command.name() === 'retry')!, 'backlog.retry', argv);
  configureBacklogJsonErrors(backlog.commands.find(command => command.name() === 'confirm-merge')!, 'backlog.confirm-merge', argv);
  configureBacklogJsonErrors(tag.commands.find(command => command.name() === 'add')!, 'backlog.tag.add', argv);
  configureBacklogJsonErrors(tag.commands.find(command => command.name() === 'remove')!, 'backlog.tag.remove', argv);

  backlog.action(() => backlog.outputHelp());
}

async function readDescription(path?: string): Promise<string> {
  const { readFile } = await import('node:fs/promises');
  if (path) return readFile(path, 'utf8');
  if (!process.stdin.isTTY) return readFile('/dev/stdin', 'utf8');
  return '';
}
