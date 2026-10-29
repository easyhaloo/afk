/**
 * The provider-neutral backlog manifest.
 *
 * A manifest is the handoff between a decomposition and the provider: it
 * names what has to exist, not where it lives in a tracker. The one thing it
 * does name is the project each item belongs to, because a requirement can
 * span repositories and a record has to land in exactly one of them.
 *
 * This module is pure. It reads a manifest, decides what has to be created
 * and in which order, and refuses a manifest that cannot be applied. It
 * never touches a provider; the records themselves are created elsewhere.
 */

/** How an item is executed once it exists. */
export type BacklogManifestExecutionMode = 'afk' | 'hitl';

/** One item of a backlog manifest. */
export interface BacklogManifestItem {
  /** The issue title, phrased as the outcome rather than as a commit. */
  title: string;
  /** The context and the intended outcome. */
  description: string;
  /**
   * The canonical project key the record belongs to: `platform:projectKey`.
   *
   * Absent means the manifest as a whole has one target, supplied by the
   * caller.
   */
  project?: string;
  /**
   * A manifest-local name other items can point at.
   *
   * A reference is either a global identity of an existing record or the ref
   * of an item in this same manifest.
   */
  ref?: string;
  /** The organizational parent: a global identity or a manifest-local ref. */
  parentId?: string;
  /** The Git execution base: a global identity or a manifest-local ref. */
  baseBacklogId?: string;
  /** The records that must complete first. */
  dependsOn: string[];
  /** How the item runs once it exists. */
  executionMode?: BacklogManifestExecutionMode;
  /** Provider-neutral business tags. */
  tags: string[];
}

/** A parsed manifest. */
export interface BacklogManifest {
  items: BacklogManifestItem[];
}

/**
 * A reference to another record.
 *
 * A global identity names a record that already exists. A local ref names an
 * item of this manifest, which does not exist yet but will, in the order the
 * plan decides.
 */
export type BacklogManifestReference =
  | { kind: 'global'; id: string }
  | { kind: 'local'; ref: string };

/** One item of the plan: what to create, where, and after what. */
export interface BacklogManifestPlanEntry {
  item: BacklogManifestItem;
  /** The canonical project key the record belongs to. */
  project: string;
  parentId?: BacklogManifestReference;
  baseBacklogId?: BacklogManifestReference;
  dependsOn: BacklogManifestReference[];
  /** The retry key that makes a repeated run return the same record. */
  idempotencyKey?: string;
}

/** The plan: every item, resolved and ordered. */
export interface BacklogManifestPlan {
  entries: BacklogManifestPlanEntry[];
}

export interface BacklogManifestPlanOptions {
  /** The project an item without its own project belongs to. */
  defaultProject?: string;
  /** The prefix the per-item retry keys are derived from. */
  idempotencyKeyPrefix?: string;
}

/** A canonical global identity: `platform:projectKey#issueNumber`. */
const GLOBAL_IDENTITY = /^[^:\s]+:[^#\s]+#[1-9]\d*$/;

/** A canonical project key: `platform:projectKey`. */
const CANONICAL_PROJECT = /^(github|gitlab):\S+$/;

/**
 * Decide what has to be created, and in which order.
 *
 * The order matters: an item that waits for another item of the same
 * manifest can only name it once that item exists, so the plan puts every
 * dependency before the item that waits for it.
 */
export function planBacklogManifest(
  manifest: BacklogManifest,
  options: BacklogManifestPlanOptions = {},
): BacklogManifestPlan {
  const items = manifest.items;
  const refs = collectRefs(items);
  const resolved = items.map(item => resolveItem(item, refs, options));
  return { entries: orderEntries(resolved) };
}

/** The manifest-local names every item declares, and where they come from. */
function collectRefs(items: readonly BacklogManifestItem[]): Map<string, BacklogManifestItem> {
  const refs = new Map<string, BacklogManifestItem>();
  for (const item of items) {
    if (item.ref === undefined) continue;
    if (refs.has(item.ref)) {
      throw new Error(`backlog manifest declares the ref "${item.ref}" twice`);
    }
    refs.set(item.ref, item);
  }
  return refs;
}

/** Resolve one item: its project, its references and its retry key. */
function resolveItem(
  item: BacklogManifestItem,
  refs: ReadonlyMap<string, BacklogManifestItem>,
  options: BacklogManifestPlanOptions,
): BacklogManifestPlanEntry {
  const project = item.project ?? options.defaultProject;
  if (project === undefined) {
    throw new Error(`backlog manifest item "${item.title}" has no project`);
  }
  if (!CANONICAL_PROJECT.test(project)) {
    throw new Error(`backlog manifest item "${item.title}" has an invalid project: ${project}`);
  }
  const parentId = item.parentId === undefined ? undefined : classify(item.parentId, refs, item);
  const dependsOn = item.dependsOn.map(reference => classify(reference, refs, item));
  const baseBacklogId = item.baseBacklogId === undefined
    ? undefined
    : classify(item.baseBacklogId, refs, item);
  if (baseBacklogId !== undefined) {
    assertSameProject(baseBacklogId, project, refs, item);
  }
  return {
    item,
    project,
    ...(parentId === undefined ? {} : { parentId }),
    ...(baseBacklogId === undefined ? {} : { baseBacklogId }),
    dependsOn,
    ...(idempotencyKey(item, options) === undefined ? {} : { idempotencyKey: idempotencyKey(item, options) }),
  };
}

/**
 * The retry key of one item.
 *
 * A manifest that is applied twice must not create the records twice, so the
 * key is derived from something stable: the ref when the item declares one,
 * the title otherwise.
 */
function idempotencyKey(
  item: BacklogManifestItem,
  options: BacklogManifestPlanOptions,
): string | undefined {
  if (options.idempotencyKeyPrefix === undefined) return undefined;
  return `${options.idempotencyKeyPrefix}/${item.ref ?? item.title}`;
}

/**
 * Tell a global identity from a manifest-local reference.
 *
 * A reference that names a record that already exists is a global identity.
 * Anything else names an item of this manifest, and it has to name one that
 * exists in it.
 */
function classify(
  reference: string,
  refs: ReadonlyMap<string, BacklogManifestItem>,
  item: BacklogManifestItem,
): BacklogManifestReference {
  if (GLOBAL_IDENTITY.test(reference)) return { kind: 'global', id: reference };
  if (!refs.has(reference)) {
    throw new Error(`backlog manifest item "${item.title}" refers to "${reference}", which no item declares`);
  }
  return { kind: 'local', ref: reference };
}

/**
 * An execution base has to live in the repository the item runs in.
 *
 * The base is the branch the work starts from, and a branch belongs to one
 * repository. A base in another repository is not a slow start, it is a
 * different baseline, and it is refused rather than silently ignored.
 */
function assertSameProject(
  base: BacklogManifestReference,
  project: string,
  refs: ReadonlyMap<string, BacklogManifestItem>,
  item: BacklogManifestItem,
): void {
  const baseProject = base.kind === 'global'
    ? projectOfGlobalId(base.id)
    : refs.get(base.ref)?.project;
  if (baseProject === undefined || baseProject !== project) {
    throw new Error(`backlog manifest item "${item.title}" has an execution base in another project`);
  }
}

/** The canonical project key a global identity belongs to. */
function projectOfGlobalId(id: string): string | undefined {
  const separator = id.lastIndexOf('#');
  if (separator < 0) return undefined;
  return id.slice(0, separator);
}

/**
 * Order the entries so every dependency comes before the item waiting for it.
 *
 * Only manifest-local dependencies constrain the order: a global identity
 * names a record that already exists and cannot delay anything.
 */
function orderEntries(entries: BacklogManifestPlanEntry[]): BacklogManifestPlanEntry[] {
  const byRef = new Map<string, BacklogManifestPlanEntry>();
  for (const entry of entries) {
    if (entry.item.ref !== undefined) byRef.set(entry.item.ref, entry);
  }
  const remaining = [...entries];
  const ordered: BacklogManifestPlanEntry[] = [];
  const placed = new Set<string>();
  while (remaining.length > 0) {
    const index = remaining.findIndex(entry => entry.dependsOn.every(reference =>
      reference.kind !== 'local' || placed.has(reference.ref)));
    if (index < 0) {
      throw new Error('backlog manifest has a dependency cycle');
    }
    const [entry] = remaining.splice(index, 1);
    ordered.push(entry);
    if (entry.item.ref !== undefined) placed.add(entry.item.ref);
  }
  return ordered;
}
