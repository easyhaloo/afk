import { readFile } from 'node:fs/promises';
import { load } from 'js-yaml';
import {
  planBacklogManifest,
  type BacklogManifest,
  type BacklogManifestExecutionMode,
  type BacklogManifestItem,
  type BacklogManifestPlan,
  type BacklogManifestPlanEntry,
  type BacklogManifestReference,
} from '@afk/application';
import type { BacklogCreateInput, BacklogManagementProvider } from '../../domain/backlog/index';

/**
 * Applying a backlog manifest.
 *
 * A manifest says what has to exist. Applying it creates the records, each
 * in the project the manifest names, and writes the relationships between
 * them: an item that waits for another one, an item that hangs under a
 * parent, an item that starts from an execution base.
 *
 * The manifest-local names are what make a manifest self-contained: a
 * reference either names a record that already exists, or names another item
 * of the same manifest. The second kind is resolved here, in the order the
 * plan decided, because a record can only point at something that exists.
 */

/** One record the manifest now names. */
export interface AppliedManifestRecord {
  /** The item the record was created for. */
  item: BacklogManifestItem;
  /** The canonical project key the record belongs to. */
  project: string;
  /** The canonical global identity of the record. */
  id: string;
  /** The provider URL, when the provider reports one. */
  url?: string;
}

/** What applying a manifest produced. */
export interface BacklogManifestApplication {
  /** The records, in the order they were created. */
  records: AppliedManifestRecord[];
}

/** The provider of one project. */
export type BacklogManifestProviderFactory = (project: string) => Promise<BacklogManagementProvider>;

/**
 * Read a manifest from a file.
 *
 * The file is YAML, because a manifest is written by a person or an agent
 * that reasons about it, not by a program that serialises it.
 */
export async function readBacklogManifest(path: string): Promise<BacklogManifest> {
  return parseBacklogManifest(await readFile(path, 'utf8'));
}

/**
 * Read a manifest from its source.
 *
 * A manifest is a list of items. Anything that is not a list, and any item
 * that does not carry the fields the contract names, is refused here rather
 * than half-applied later.
 */
export function parseBacklogManifest(source: string): BacklogManifest {
  const document = load(source);
  if (!Array.isArray(document)) {
    throw new Error('backlog manifest must be a list of items');
  }
  return { items: document.map((entry, index) => parseItem(entry, index)) };
}

/** Read one item of a manifest. */
function parseItem(entry: unknown, index: number): BacklogManifestItem {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new Error(`backlog manifest item ${index + 1} must be an object`);
  }
  const candidate = entry as Record<string, unknown>;
  const title = requiredText(candidate.title, `item ${index + 1} title`);
  const description = requiredText(candidate.description, `item ${index + 1} description`);
  const executionMode = candidate.executionMode === undefined
    ? undefined
    : parseExecutionMode(candidate.executionMode, index);
  return {
    title,
    description,
    ...(optionalText(candidate.project) === undefined ? {} : { project: optionalText(candidate.project) }),
    ...(optionalText(candidate.ref) === undefined ? {} : { ref: optionalText(candidate.ref) }),
    ...(optionalText(candidate.parentId) === undefined ? {} : { parentId: optionalText(candidate.parentId) }),
    ...(optionalText(candidate.baseBacklogId) === undefined ? {} : { baseBacklogId: optionalText(candidate.baseBacklogId) }),
    dependsOn: stringList(candidate.dependsOn, `item ${index + 1} dependsOn`),
    ...(executionMode === undefined ? {} : { executionMode }),
    tags: stringList(candidate.tags, `item ${index + 1} tags`),
  };
}

/** The execution mode of an item, when it names one. */
function parseExecutionMode(value: unknown, index: number): BacklogManifestExecutionMode {
  if (value !== 'afk' && value !== 'hitl') {
    throw new Error(`backlog manifest item ${index + 1} has an invalid executionMode: ${String(value)}`);
  }
  return value;
}

/** A field that has to carry text. */
function requiredText(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`backlog manifest ${label} must not be empty`);
  }
  return value;
}

/** A field that may carry text. */
function optionalText(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || !value.trim()) return undefined;
  return value;
}

/** A field that carries a list of strings. */
function stringList(value: unknown, label: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some(entry => typeof entry !== 'string')) {
    throw new Error(`backlog manifest ${label} must be a list of strings`);
  }
  return value as string[];
}

/**
 * Create the records a manifest names.
 *
 * The provider of a project is asked for once: a manifest that spreads its
 * items over five repositories still needs one provider per repository, not
 * one per item.
 */
export async function applyBacklogManifest(
  plan: BacklogManifestPlan,
  create: BacklogManifestProviderFactory,
): Promise<BacklogManifestApplication> {
  const providers = new Map<string, BacklogManagementProvider>();
  const created = new Map<string, string>();
  const records: AppliedManifestRecord[] = [];

  for (const entry of plan.entries) {
    let provider = providers.get(entry.project);
    if (!provider) {
      provider = await create(entry.project);
      providers.set(entry.project, provider);
    }
    const item = await provider.create(toCreateInput(entry, created));
    const id = item.workItemId ?? item.id;
    if (entry.item.ref !== undefined) created.set(entry.item.ref, id);
    records.push({
      item: entry.item,
      project: entry.project,
      id,
      ...(item.webUrl === undefined ? {} : { url: item.webUrl }),
    });
  }

  return { records };
}

/**
 * The creation input of one item.
 *
 * A manifest-local reference becomes the identity of the record it created;
 * a global identity is already what it is.
 */
function toCreateInput(entry: BacklogManifestPlanEntry, created: ReadonlyMap<string, string>): BacklogCreateInput {
  return {
    title: entry.item.title,
    description: entry.item.description,
    ...(entry.parentId === undefined ? {} : { parentId: resolveReference(entry.parentId, created) }),
    ...(entry.baseBacklogId === undefined ? {} : { baseBacklogId: resolveReference(entry.baseBacklogId, created) }),
    dependsOn: entry.dependsOn.map(reference => resolveReference(reference, created)),
    ...(entry.item.executionMode === undefined ? {} : { executionMode: entry.item.executionMode }),
    ...(entry.item.tags.length ? { tags: entry.item.tags } : {}),
    ...(entry.idempotencyKey === undefined ? {} : { idempotencyKey: entry.idempotencyKey }),
  };
}

/**
 * The identity a reference names.
 *
 * A manifest-local reference has to be resolved by now: the plan puts every
 * record it depends on first, so a name that is still unknown is a manifest
 * that could not be planned.
 */
function resolveReference(reference: BacklogManifestReference, created: ReadonlyMap<string, string>): string {
  if (reference.kind === 'global') return reference.id;
  const id = created.get(reference.ref);
  if (id === undefined) {
    throw new Error(`backlog manifest reference "${reference.ref}" was not created before it was used`);
  }
  return id;
}

export { planBacklogManifest };
export type { BacklogManifest, BacklogManifestPlan };
