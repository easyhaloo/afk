import { Command, Option } from 'commander';
import chalk from 'chalk';
import { readFile } from 'node:fs/promises';
import {
  createGlobalWorkItemCatalogs,
  createManagementProviders,
  resolveProviderAccountIdentities,
  type GlobalTrackerPlatform,
  type ManagementProviderBundle,
  type TrackerPlatform,
} from '@afk/runtime/infrastructure/provider/tracker-provider-factory';
import {
  collectGlobalWorkItemInventory,
  filterGlobalWorkItemInventory,
} from '@afk/runtime/infrastructure/provider/inventory';
import { resolveTrackerTarget } from '@afk/runtime/infrastructure/tracker/target';
import { recordTrackerActivity, trackerIdentityOf, findProjectByName, readTrackerStore } from '@afk/runtime/infrastructure/tracker/store';
import type {
  GlobalWorkItem,
  GlobalWorkItemInventoryResult,
  InventoryDiagnostic,
  ProviderCatalog,
} from '@afk/runtime/domain/work-item/provider-types';
import { verifiedInventoryNamespace, SqliteInventoryStore } from '@afk/runtime/storage';
import {
  createMirrorWorkItemChildrenInventory,
  listWorkItemChildren,
  type WorkItemChildrenResult,
} from '@afk/runtime/application/work-item/children';
import { toGlobalWorkItems } from '@afk/runtime/application/work-item/inventory-items';
import {
  applyBacklogManifest,
  parseBacklogManifest,
  type BacklogManifestProviderFactory,
} from '@afk/runtime/application/work-item/apply-manifest';
import { planBacklogManifest } from '@afk/application';
import { parseCanonicalProject, parseWorkItemId, canonicalProjectKey, formatWorkItemId, gitLabProjectHost } from '@afk/runtime/domain/work-item/identity';
import type { InventoryItem, InventoryProject, InventorySnapshot } from '@afk/application';
import {
  addBacklogTag,
  adoptBacklog,
  confirmBacklogMerge,
  createBacklog,
  initializeBacklog,
  interruptBacklog,
  listBacklogs,
  reconcileMergedBacklog,
  removeBacklogTag,
  retryBacklog,
  showBacklog,
  type BacklogChangeProvider,
  type BacklogManagementProvider,
  type BacklogMergeReconciliation,
} from '@afk/runtime/domain/backlog/commands';
import type { BacklogCreateInput, BacklogItem, BacklogKind, BacklogState, QABacklogProvider } from '@afk/runtime/domain/backlog/index';
import type { BacklogExecutionMode } from '@afk/runtime/domain/backlog/index';
import { getWorkflowConfig } from '@afk/runtime/infrastructure/config/manager';
import { handleCommandError, success, warning, detail } from '../output.js';
import type { CommandRegistrationContext } from '../command-registry.js';
import {
  classifyError,
  emitFailure,
  emitSuccess,
} from '../output.js';

const states: BacklogState[] = ['ready', 'rework', 'in_progress', 'verification', 'merge_ready', 'done', 'blocked'];
const kinds: BacklogKind[] = ['prd'];
const modes: BacklogExecutionMode[] = ['afk', 'hitl'];
const inventoryPlatforms: GlobalTrackerPlatform[] = ['github', 'gitlab', 'all'];

function asPlatform(value: unknown): TrackerPlatform | undefined {
  return value === 'github' || value === 'gitlab' ? value : undefined;
}

/** The provider project a backlog command addresses. */
interface BacklogTarget {
  platform: TrackerPlatform;
  projectId: string;
  host?: string;
}

/**
 * Resolve the provider target of one backlog command.
 *
 * The issue id takes part in the lookup: the local tracker index maps every
 * issue AFK has worked with to its provider project, so a bare id is enough
 * to find that project from any directory.
 */
async function resolveBacklogTarget(
  project?: string,
  platform?: unknown,
  issueId?: string,
): Promise<BacklogTarget> {
  const target = await resolveTrackerTarget({
    project,
    platform: asPlatform(platform),
    issueId,
    cwd: process.cwd(),
  });
  return { platform: target.platform, projectId: target.projectId, host: target.host };
}

/** Create the management bundle for a resolved target. */
function providersFor(target: BacklogTarget): Promise<ManagementProviderBundle> {
  return createManagementProviders(target.projectId, process.cwd(), target.platform, target.host);
}

/** Create the backlog provider for a command target. */
async function backlogProviderFor(
  project?: string,
  platform?: unknown,
  issueId?: string,
): Promise<BacklogManagementProvider> {
  const target = await resolveBacklogTarget(project, platform, issueId);
  return (await providersFor(target)).backlog;
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
  // A PRD anchor is a container and has no lifecycle position, so saying
  // "none" is more useful than printing an empty state.
  detail(`state: ${item.state ?? 'none'}  mode: ${item.executionMode}`);
  if (item.kind) detail(`role: ${item.kind} (organizational anchor; never executed)`);
  if (item.parentId) detail(`parent: ${item.parentId}`);
  if (item.baseBacklogId) detail(`execution-base: ${item.baseBacklogId}`);
  if (item.dependsOn.length) detail(`depends-on: ${item.dependsOn.join(', ')}`);
  if (item.tags.length) detail(`tags: ${item.tags.join(', ')}`);
  detail(`branch: ${item.branchName}`);
}

export type JsonMode = { json?: boolean };

/**
 * Teach the local tracker index what an inventory found.
 *
 * An inventory touches every project the credentials reach, so it is the
 * cheapest way to learn which issues live where. Later commands resolve a
 * bare issue id through that index.
 */
function recordInventory(items: readonly GlobalWorkItem[]): void {
  const groups = new Map<string, {
    platform: TrackerPlatform;
    project: string;
    host?: string;
    issues: Array<{ id: string; title?: string }>;
  }>();
  for (const item of items) {
    const identity = trackerIdentityOf(item.project);
    const key = `${item.project.platform}:${identity.host ?? ''}:${identity.project}`;
    const group = groups.get(key) ?? {
      platform: item.project.platform,
      project: identity.project,
      host: identity.host,
      issues: [] as Array<{ id: string; title?: string }>,
    };
    group.issues.push({ id: String(item.issueNumber), title: item.title });
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    recordTrackerActivity({ ...group, cwd: process.cwd() });
  }
}

export interface BacklogInventoryOptions extends JsonMode {
  platform?: string;
  state?: string;
  kind?: string;
  mode?: string;
  tag?: string;
  project?: string;
}

export async function runBacklogInventory(
  catalogFactory: (platform: GlobalTrackerPlatform) => ProviderCatalog[],
  options: BacklogInventoryOptions = {},
  storage?: { root?: string },
): Promise<void> {
  const kind = 'backlog.inventory';
  try {
    const platform = options.platform ?? 'all';
    if (!inventoryPlatforms.includes(platform as GlobalTrackerPlatform)) {
      throw new Error(`invalid inventory platform: ${platform}`);
    }
    if (options.state && !states.includes(options.state as BacklogState)) {
      throw new Error(`invalid backlog state: ${options.state}`);
    }
    if (options.kind && !kinds.includes(options.kind as BacklogKind)) {
      throw new Error(`invalid backlog role: ${options.kind}`);
    }
    if (options.mode && !modes.includes(options.mode as BacklogExecutionMode)) {
      throw new Error(`invalid execution mode: ${options.mode}`);
    }
    const catalogs = catalogFactory(platform as GlobalTrackerPlatform);
    const completeResult = await collectGlobalWorkItemInventory(catalogs);
    const publishDiagnostics = storage ? await persistInventory(catalogs, completeResult, storage.root) : [];
    const filtered = filterGlobalWorkItemInventory(
      completeResult,
      {
        state: options.state as BacklogState | undefined,
        kind: options.kind as BacklogKind | undefined,
        mode: options.mode as BacklogExecutionMode | undefined,
        tag: options.tag,
        project: options.project,
      },
    );
    // The local mirror is a cache, not the source of truth: a publish failure
    // is reported as a diagnostic but never discards the collected inventory.
    const result: GlobalWorkItemInventoryResult = publishDiagnostics.length
      ? {
        ...filtered,
        diagnostics: [...filtered.diagnostics, ...publishDiagnostics].sort(compareInventoryDiagnostics),
        complete: false,
      }
      : filtered;
    recordInventory(result.items);
    if (options.json) {
      emitSuccess<GlobalWorkItemInventoryResult>(kind, result);
      return;
    }
    if (result.items.length === 0) {
      warning('No work items found');
      return;
    }
    for (const item of result.items) {
      console.log(`${chalk.bold(item.id)}  ${item.title}`);
    }
  } catch (error) {
    if (options.json) {
      emitFailure(kind, classifyError(error), (error as Error).message);
      return;
    }
    throw error;
  }
}

/**
 * Publish the collected inventory to the local SQLite mirror.
 *
 * Publishing is best effort. The mirror is a cache, not the source of truth,
 * so a failure is reported as a diagnostic instead of aborting the command.
 *
 * The namespace identifies the whole account set. When an account cannot be
 * verified there is no stable user id for it, and a store opened for the
 * remaining accounts would be the wrong store for whichever account the
 * unverified one turns out to be — so nothing is published until every
 * account in the set is verified.
 */
async function persistInventory(
  catalogs: readonly ProviderCatalog[],
  result: GlobalWorkItemInventoryResult,
  root?: string,
): Promise<InventoryDiagnostic[]> {
  const diagnostics: InventoryDiagnostic[] = [];
  const resolution = await resolveProviderAccountIdentities(catalogs);
  const namespaceKey = verifiedInventoryNamespace(resolution.identities);
  if (!namespaceKey) {
    for (const failure of resolution.failures) {
      diagnostics.push({
        platform: failure.platform,
        projectKey: failure.scopeKey,
        code: 'inventory_identity_unverified',
        message: failure.message,
        retryable: true,
      });
    }
    return diagnostics;
  }
  const store = new SqliteInventoryStore({ root, namespaceKey });
  let current: ProviderCatalog | undefined;
  try {
    for (const [index, catalog] of catalogs.entries()) {
      current = catalog;
      const identity = resolution.identities[index];
      if (!identity) continue;
      const host = identity.host;
      const projects = result.projects.filter(project => project.platform === catalog.platform && (project.providerHost ?? catalog.scopeKey) === catalog.scopeKey);
      const projectKeys = new Set(projects.map(project => project.projectKey));
      const items = result.items.filter(item => item.project.platform === catalog.platform && (item.project.providerHost ?? catalog.scopeKey) === catalog.scopeKey);
      const catalogDiagnostics = result.diagnostics.filter(diagnostic =>
        diagnostic.platform === catalog.platform
        && (!diagnostic.projectKey || diagnostic.projectKey === catalog.scopeKey || projectKeys.has(diagnostic.projectKey)));
      const snapshot: InventorySnapshot = {
        items: items as unknown as InventoryItem[],
        projects: projects as unknown as InventoryProject[],
        diagnostics: catalogDiagnostics,
        complete: result.complete && catalogDiagnostics.length === 0,
      };
      const attempt = await store.begin({ platform: catalog.platform, host, kind: 'catalog' });
      await store.publish(attempt, snapshot);
    }
  } catch (error) {
    const scope = current ?? catalogs[0];
    diagnostics.push({
      platform: scope?.platform ?? 'gitlab',
      projectKey: scope?.scopeKey ?? '',
      code: 'inventory_publish_failed',
      message: error instanceof Error ? error.message : String(error),
      retryable: true,
    });
  } finally {
    store.close();
  }
  return diagnostics;
}

function compareInventoryDiagnostics(left: InventoryDiagnostic, right: InventoryDiagnostic): number {
  return left.platform.localeCompare(right.platform)
    || left.projectKey.localeCompare(right.projectKey)
    || left.code.localeCompare(right.code);
}

/**
 * Action helper for `backlog list`. Emits the success envelope when
 * `options.json` is true; otherwise prints human-readable rows. Errors
 * route through `emitFailure` in JSON mode so callers can rely on the
 * structured protocol regardless of exit reason.
 */
export async function runBacklogList(
  provider: BacklogManagementProvider,
  options: { state?: string; kind?: string; mode?: string; tag?: string; parent?: string; project?: string; json?: boolean } = {},
): Promise<void> {
  const kind = 'backlog.list';
  try {
    if (options.state && !states.includes(options.state as BacklogState)) {
      throw new Error(`invalid backlog state: ${options.state}`);
    }
    if (options.kind && !kinds.includes(options.kind as BacklogKind)) {
      throw new Error(`invalid backlog role: ${options.kind}`);
    }
    if (options.mode && !modes.includes(options.mode as BacklogExecutionMode)) {
      throw new Error(`invalid execution mode: ${options.mode}`);
    }
    const items = await listBacklogs(provider, {
      state: options.state as BacklogState | undefined,
      kind: options.kind as BacklogKind | undefined,
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

export interface BacklogChildrenOptions extends JsonMode {
  /** The project the queried item belongs to, when the id does not name one. */
  project?: string;
  /** Override provider detection. */
  platform?: string;
}

/** Where the identity of the queried item is resolved from. */
export interface BacklogChildrenIdentitySources {
  /** Resolve the tracker target that owns the item. */
  target?: typeof resolveTrackerTarget;
  /** The instance a project lives on. */
  host?: (projectId: string) => string | undefined;
}

export interface BacklogChildrenDependencies {
  /** The locally stored parent and its children. */
  read?: (parentId: string) => Promise<{ items: readonly GlobalWorkItem[]; lastSuccessAt?: number } | undefined>;
  /** Collect the items from the providers again. */
  collect?: () => Promise<{ items: readonly GlobalWorkItem[] } | undefined>;
  /** The canonical identity of the queried item. */
  resolve?: (value: string, options: BacklogChildrenOptions) => Promise<string>;
}

/**
 * The identity of the queried item.
 *
 * A canonical identity already names the project it belongs to. An issue
 * number does not: the same number is a different issue in every repository,
 * so the project is resolved the way every other backlog command resolves it
 * — the explicit flag first, then the local index, then the environment.
 */
export async function resolveBacklogChildrenIdentity(
  value: string,
  options: BacklogChildrenOptions = {},
  sources: BacklogChildrenIdentitySources = {},
): Promise<string> {
  const text = value.trim();
  if (!text) throw new Error('a work item id is required');
  if (text.includes('#')) return canonicalParentId(text);
  const issueNumber = Number(text);
  if (!Number.isSafeInteger(issueNumber) || issueNumber <= 0) {
    throw new Error(`work item id must be an issue number or platform:projectKey#issueNumber: ${value}`);
  }
  const resolveTarget = sources.target ?? resolveTrackerTarget;
  const resolved = await resolveTarget({
    ...(options.project === undefined ? {} : { project: options.project }),
    ...(options.platform === undefined ? {} : { platform: options.platform }),
    issueId: text,
  });
  const host = resolved.host ?? (sources.host ?? hostOfProject)(resolved.projectId);
  return formatWorkItemId({
    platform: resolved.platform,
    projectKey: projectKeyOf(resolved.platform, resolved.projectId, host),
    issueNumber,
  });
}

/**
 * The instance a project lives on.
 *
 * A project path does not name the instance it belongs to — the same path can
 * exist on two of them — so the identity would be wrong without it. The local
 * index records where AFK last saw the project.
 */
function hostOfProject(projectId: string): string | undefined {
  return findProjectByName(readTrackerStore(), projectId)?.host;
}

/**
 * The canonical key of a project.
 *
 * A project that already carries its host is already a canonical key: the
 * host is part of the identity, and guessing it would name a different
 * project than the one the caller meant.
 */
function projectKeyOf(platform: TrackerPlatform, projectId: string, host?: string): string {
  if (platform === 'gitlab') {
    const embedded = gitLabProjectHost(projectId);
    if (embedded) return canonicalProjectKey(platform, projectId.slice(embedded.length + 1), embedded);
  }
  return canonicalProjectKey(platform, projectId, host);
}

/**
 * List the issues that belong to one work item.
 *
 * The local mirror answers first. A missing or stale mirror is collected
 * again before the question is answered, so a PRD that was split after the
 * last collection still reports its children.
 */
export async function runBacklogChildren(
  parentId: string,
  options: BacklogChildrenOptions,
  dependencies: BacklogChildrenDependencies = {},
): Promise<void> {
  const kind = 'backlog.children';
  try {
    const identity = await (dependencies.resolve ?? resolveBacklogChildrenIdentity)(parentId, options);
    const inventory = createMirrorWorkItemChildrenInventory({
      read: dependencies.read ?? readChildrenFromMirror,
      collect: dependencies.collect ?? collectWorkItems,
    });
    const result = await listWorkItemChildren(inventory, { parentId: identity });
    if (options.json) {
      emitSuccess(kind, { parent: result.parent, children: result.children, source: result.source });
      return;
    }
    printChildren(result);
  } catch (error) {
    if (options.json) {
      emitFailure(kind, classifyError(error), (error as Error).message);
      return;
    }
    throw error;
  }
}

/**
 * The dependencies of the manifest command.
 *
 * The manifest is read from a source and the records are written through a
 * provider, and both are injected so the command can be exercised without a
 * provider at all.
 */
export interface BacklogApplyManifestDependencies {
  /** The manifest source. */
  read: (path: string) => Promise<string>;
  /** The provider of one canonical project key. */
  create: BacklogManifestProviderFactory;
}

export interface BacklogApplyManifestOptions extends JsonMode {
  /** The manifest file. */
  manifest?: string;
  /** The project an item without its own project belongs to. */
  project?: string;
  /** Override provider detection. */
  platform?: string;
  /** The prefix the per-item retry keys are derived from. */
  idempotencyKey?: string;
  /** Plan and report without writing anything. */
  dryRun?: boolean;
}

/**
 * Apply a backlog manifest.
 *
 * The manifest names what has to exist and, per item, which project it
 * belongs to. Every record is written in the project it names, and the
 * relationships between the records are written with them.
 */
export async function runBacklogApplyManifest(
  dependencies: BacklogApplyManifestDependencies,
  options: BacklogApplyManifestOptions = {},
): Promise<void> {
  const kind = 'backlog.apply-manifest';
  try {
    if (!options.manifest) throw new Error('a manifest file is required');
    const manifest = parseBacklogManifest(await dependencies.read(options.manifest));
    const plan = planBacklogManifest(manifest, {
      ...(options.project === undefined ? {} : { defaultProject: options.project }),
      ...(options.idempotencyKey === undefined ? {} : { idempotencyKeyPrefix: options.idempotencyKey }),
    });
    if (options.dryRun) {
      const records = plan.entries.map(entry => ({
        item: entry.item,
        project: entry.project,
        planned: true,
      }));
      if (options.json) {
        emitSuccess(kind, { records, dryRun: true });
        return;
      }
      for (const record of records) {
        console.log(`${chalk.bold(record.project)}  ${record.item.title}`);
      }
      return;
    }
    const result = await applyBacklogManifest(plan, dependencies.create);
    if (options.json) {
      emitSuccess(kind, result);
      return;
    }
    for (const record of result.records) {
      success(`Created ${record.id}: ${record.item.title}`);
      detail(`project: ${record.project}`);
      if (record.url) detail(`url: ${record.url}`);
    }
  } catch (error) {
    if (options.json) {
      emitFailure(kind, classifyError(error), (error as Error).message);
      return;
    }
    handleCommandError(error);
  }
}

/**
 * The provider of every project a manifest names.
 *
 * The canonical key says which repository a record belongs to, including
 * the instance it lives on, so the provider is created for that repository
 * and not for the one the command happens to run in.
 */
function manifestProviderFactory(): BacklogManifestProviderFactory {
  const providers = new Map<string, Promise<BacklogManagementProvider>>();
  return (project: string) => {
    const existing = providers.get(project);
    if (existing) return existing;
    const created = (async () => {
      const { platform, projectId, host } = parseCanonicalProject(project);
      const bundle = await createManagementProviders(projectId, process.cwd(), platform, host);
      return bundle.backlog;
    })();
    providers.set(project, created);
    return created;
  };
}

/**
 * The identity of the queried item.
 *
 * A bare issue number names a different issue in every repository, so only
 * the canonical identity can address one.
 */
function canonicalParentId(value: string): string {
  try {
    return parseWorkItemId(value).id;
  } catch {
    throw new Error(`work item id must use platform:projectKey#issueNumber: ${value}`);
  }
}

function printChildren(result: WorkItemChildrenResult<GlobalWorkItem>): void {
  console.log(itemLine(result.parent));
  detail(`state: ${result.parent.state ?? 'none'}  mode: ${result.parent.executionMode}`);
  if (result.parent.kind) detail(`role: ${result.parent.kind} (organizational anchor; never executed)`);
  if (result.children.length === 0) {
    warning('No child issues found');
    return;
  }
  for (const child of result.children) {
    console.log(itemLine(child));
    detail(`state: ${child.state}  mode: ${child.executionMode}  managed: ${child.managed ? 'yes' : 'no'}`);
  }
}

/**
 * One item, with the URL the provider reported.
 *
 * The URL sits on the line that names the item: the title is what a person
 * reads, and the link is what they click.
 */
function itemLine(item: GlobalWorkItem): string {
  const heading = `${chalk.bold(item.id)}  ${item.title}`;
  return item.webUrl ? `${heading}  ${item.webUrl}` : heading;
}

/**
 * Open the local mirror of the work item inventory.
 *
 * The mirror is stored per account set, so it can only be opened when every
 * account is verified. Without one the query falls back to the providers.
 */
async function openInventoryMirror(): Promise<SqliteInventoryStore | undefined> {
  const catalogs = createGlobalWorkItemCatalogs('all');
  const resolution = await resolveProviderAccountIdentities(catalogs);
  const namespaceKey = verifiedInventoryNamespace(resolution.identities);
  if (!namespaceKey) return undefined;
  return new SqliteInventoryStore({ namespaceKey });
}

/** The parent and its children as the local mirror holds them. */
async function readChildrenFromMirror(
  parentId: string,
): Promise<{ items: readonly GlobalWorkItem[]; lastSuccessAt?: number } | undefined> {
  const store = await openInventoryMirror();
  if (!store) return undefined;
  try {
    const page = await store.query({ parentId });
    const parent = await store.get(parentId);
    const items = [...(parent ? [parent] : []), ...page.items];
    return { items: toGlobalWorkItems(items), lastSuccessAt: page.lastSuccessAt };
  } finally {
    store.close();
  }
}

/**
 * Collect the work items again and publish them to the mirror.
 *
 * Publishing is best effort. The answer does not depend on the mirror being
 * writable, so a failed publish costs the cache but not the query.
 */
async function collectWorkItems(): Promise<{ items: readonly GlobalWorkItem[] } | undefined> {
  const catalogs = createGlobalWorkItemCatalogs('all');
  const collected = await collectGlobalWorkItemInventory(catalogs);
  await persistInventory(catalogs, collected);
  return { items: collected.items };
}

export async function runBacklogCreate(
  provider: BacklogManagementProvider,
  options: { title: string; descriptionFile?: string; parent?: string; baseBacklog?: string; dependsOn?: string[]; mode?: string; kind?: string; dryRun?: boolean; idempotencyKey?: string; tag?: string[]; project?: string; json?: boolean } & { description?: string },
): Promise<void> {
  const kind = 'backlog.create';
  try {
    if (!options.title) throw new Error('backlog title is required');
    if (options.mode && !modes.includes(options.mode as BacklogExecutionMode)) {
      throw new Error(`invalid execution mode: ${options.mode}`);
    }
    if (options.kind !== undefined && !kinds.includes(options.kind as BacklogKind)) {
      throw new Error(`invalid backlog role: ${options.kind}`);
    }
    const description = options.description ?? await readDescription(options.descriptionFile);
    if (!description.trim()) throw new Error('empty backlog description. Provide --description-file or pipe Markdown through stdin.');
    const input: BacklogCreateInput = {
      title: options.title,
      description,
      kind: options.kind as BacklogCreateInput['kind'],
      idempotencyKey: options.idempotencyKey,
      parentId: options.parent,
      baseBacklogId: options.baseBacklog,
      dependsOn: options.dependsOn,
      executionMode: options.mode as BacklogExecutionMode | undefined,
      tags: options.tag,
    };
    if (options.dryRun) {
      const { links, idempotencyLabel, ...plan } = await provider.planCreate(input);
      if (options.json) emitSuccess(kind, { dryRun: true, ...plan });
      else process.stdout.write(`${JSON.stringify({ dryRun: true, ...plan }, null, 2)}\n`);
      return;
    }
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

export async function runBacklogAdopt(
  provider: BacklogManagementProvider,
  id: string,
  options: JsonMode = {},
): Promise<void> {
  await runLifecycleAction('backlog.adopt', options, () => adoptBacklog(provider, id), `Backlog ${id} adopted`);
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

export async function runBacklogReconcileMerge(
  provider: QABacklogProvider,
  changes: BacklogChangeProvider,
  id: string,
  expectedTargetBranch: string,
  options: JsonMode = {},
): Promise<void> {
  try {
    const outcome = await reconcileMergedBacklog(provider, changes, id, expectedTargetBranch);
    if (options.json) {
      emitSuccess<BacklogMergeReconciliation>('backlog.reconcile-merge', outcome);
      return;
    }
    if (outcome.reconciled) success(`Backlog ${id} completed: ${outcome.reason}`);
    else warning(`Backlog ${id} unchanged: ${outcome.reason}`);
  } catch (error) {
    if (options.json) {
      emitFailure('backlog.reconcile-merge', classifyError(error), (error as Error).message);
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

  backlog.command('adopt')
    .description('Explicitly adopt an open manual issue into ready AFK work')
    .requiredOption('--id <id>', 'Backlog ID')
    .requiredOption('--project <project>', 'Provider project/repository')
    .addOption(new Option('--platform <platform>', 'Provider platform').choices(['github', 'gitlab']).makeOptionMandatory())
    .option('--json', 'Emit structured JSON envelope to stdout')
    .action(async options => {
      try {
        if (!options.id.trim()) throw new Error('backlog id must not be empty');
        if (!options.project.trim()) throw new Error('provider project must not be empty');
        await runBacklogAdopt(await backlogProviderFor(options.project, options.platform), options.id, options);
      } catch (error) {
        if (options.json) {
          emitFailure('backlog.adopt', classifyError(error), (error as Error).message);
          return;
        }
        handleCommandError(error);
      }
    });

  backlog.command('init')
    .description('Initialize provider metadata for backlog state and mode')
    .option('--project <project>', 'Provider project/repository')
    .option('--platform <platform>', 'Override provider detection (github|gitlab)')
    .option('--json', 'Emit structured JSON envelope to stdout')
    .action(async options => {
      try {
        const provider = await backlogProviderFor(options.project, options.platform);
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

  backlog.command('inventory')
    .description('Inventory issues across all credential-accessible projects')
    .option('--platform <platform>', 'Provider scope (github|gitlab|all)', 'all')
    .option('--state <state>', `Filter by state (${states.join('|')})`)
    .option('--kind <kind>', `Filter by role (${kinds.join('|')}); a PRD anchor has no state`)
    .option('--mode <mode>', `Filter by execution mode (${modes.join('|')})`)
    .option('--tag <tag>', 'Filter by business tag')
    .option('--project <project>', 'Filter by canonical provider project key')
    .option('--json', 'Emit structured JSON envelope to stdout')
    .action(async options => {
      try {
        await runBacklogInventory(createGlobalWorkItemCatalogs, options, {});
      } catch (error) {
        if (options.json) {
          emitFailure('backlog.inventory', classifyError(error), (error as Error).message);
          return;
        }
        handleCommandError(error);
      }
    });

  backlog.command('list')
    .description('List backlog items')
    .option('--state <state>', `Filter by state (${states.join('|')})`)
    .option('--kind <kind>', `Filter by role (${kinds.join('|')}); a PRD anchor has no state`)
    .option('--mode <mode>', `Filter by execution mode (${modes.join('|')})`)
    .option('--tag <tag>', 'Filter by business tag')
    .option('--parent <id>', 'Filter by parent backlog ID')
    .option('--project <project>', 'Provider project/repository')
    .option('--platform <platform>', 'Override provider detection (github|gitlab)')
    .option('--json', 'Emit structured JSON envelope to stdout')
    .action(async options => {
      try {
        await runBacklogList(await backlogProviderFor(options.project, options.platform), options);
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
        await runBacklogShow(await backlogProviderFor(options.project, options.platform, options.id), options.id, options);
      } catch (error) {
        if (options.json) {
          emitFailure('backlog.show', classifyError(error), (error as Error).message);
          return;
        }
        handleCommandError(error);
      }
    });

  backlog
    .command('children')
    .description('List the issues that belong to one work item')
    .argument('<prd-id>', 'Issue number or canonical work item ID (platform:projectKey#issueNumber)')
    .option('--project <project>', 'Project the item belongs to, when the id does not name one')
    .option('--platform <platform>', 'Override provider detection (github|gitlab)')
    .option('--json', 'Emit structured JSON envelope to stdout')
    .action(async (prdId: string, options) => {
      try {
        await runBacklogChildren(prdId, options);
      } catch (error) {
        if (options.json) {
          emitFailure('backlog.children', classifyError(error), (error as Error).message);
          return;
        }
        handleCommandError(error);
      }
    });

  backlog
    .command('apply-manifest')
    .description('Create the backlog records a provider-neutral manifest names')
    .argument('<manifest>', 'Manifest file (YAML)')
    .option('--project <project>', 'Default target project (platform:projectKey)')
    .option('--platform <platform>', 'Override provider detection (github|gitlab)')
    .option('--idempotency-key <key>', 'Prefix for the per-item retry keys')
    .option('--dry-run', 'Report the plan without writing anything')
    .option('--json', 'Emit structured JSON envelope to stdout')
    .action(async (manifest: string, options) => {
      try {
        await runBacklogApplyManifest({
          read: async path => readFile(path, 'utf8'),
          create: manifestProviderFactory(),
        }, { ...options, manifest });
      } catch (error) {
        if (options.json) {
          emitFailure('backlog.apply-manifest', classifyError(error), (error as Error).message);
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
    .option('--parent <id>', 'Organizational parent backlog ID or platform:project#id (does not select a git base branch)')
    .option('--base-backlog <id>', 'Backlog ID or platform:project#id whose unmerged branch is the explicit execution base')
    .option('-d, --depends-on <id>', 'Backlog ID or platform:project#id that must complete first', (value: string, previous: string[]) => [...previous, value], [])
    .option('--mode <mode>', `Execution mode (${modes.join('|')}); defaults to afk, or hitl for a PRD anchor`)
    .option('--kind <kind>', `Organizational role (${kinds.join('|')}); a PRD anchor is never executed`)
    .option('--dry-run', 'Validate and print the planned issue and labels without writing')
    .option('--idempotency-key <key>', 'Return the existing issue when this project already contains the key')
    .option('--tag <tag>', 'Business tag', (value: string, previous: string[]) => [...previous, value], [])
    .option('--project <project>', 'Provider project/repository')
    .option('--platform <platform>', 'Override provider detection (github|gitlab)')
    .option('--json', 'Emit structured JSON envelope to stdout')
    .action(async (title: string, options) => {
      try {
        await runBacklogCreate(await backlogProviderFor(options.project, options.platform), { title, ...options });
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
        const providers = await providersFor(await resolveBacklogTarget(options.project, options.platform, options.id));
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
        const providers = await providersFor(await resolveBacklogTarget(options.project, options.platform, options.id));
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
        const providers = await providersFor(await resolveBacklogTarget(options.project, options.platform, options.id));
        await runBacklogConfirmMerge(providers.backlog, providers.changes, options.id, getWorkflowConfig().targetBranch, options);
      } catch (error) {
        if (options.json) {
          emitFailure('backlog.confirm-merge', classifyError(error), (error as Error).message);
          return;
        }
        handleCommandError(error);
      }
    });

  backlog.command('reconcile-merge')
    .description('Complete a root backlog whose change is already merged on the provider')
    .requiredOption('--id <id>', 'Backlog ID')
    .option('--project <project>', 'Provider project/repository')
    .option('--platform <platform>', 'Override provider detection (github|gitlab)')
    .option('--json', 'Emit structured JSON envelope to stdout')
    .action(async options => {
      try {
        const providers = await providersFor(await resolveBacklogTarget(options.project, options.platform, options.id));
        await runBacklogReconcileMerge(providers.backlog, providers.changes, options.id, getWorkflowConfig().targetBranch, options);
      } catch (error) {
        if (options.json) {
          emitFailure('backlog.reconcile-merge', classifyError(error), (error as Error).message);
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
        await runBacklogTagAdd(await backlogProviderFor(options.project, options.platform, options.id), options.id, options.tag, options);
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
        await runBacklogTagRemove(await backlogProviderFor(options.project, options.platform, options.id), options.id, options.tag, options);
      } catch (error) {
        if (options.json) {
          emitFailure('backlog.tag.remove', classifyError(error), (error as Error).message);
          return;
        }
        handleCommandError(error);
      }
    });

  configureBacklogJsonErrors(backlog.commands.find(command => command.name() === 'init')!, 'backlog.init', argv);
  configureBacklogJsonErrors(backlog.commands.find(command => command.name() === 'adopt')!, 'backlog.adopt', argv);
  configureBacklogJsonErrors(backlog.commands.find(command => command.name() === 'inventory')!, 'backlog.inventory', argv);
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
