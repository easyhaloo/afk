import type {
  BacklogCreateInput,
  BacklogExecutionMode,
  BacklogItem,
  BacklogKind,
  BacklogManagementProvider,
  BacklogState,
} from './index.js';
import { BACKLOG_KIND_LABELS, BACKLOG_METADATA } from './initialization.js';
import { validateBusinessTag } from './tags.js';
import {
  canonicalizeBacklogReference,
  encodeBacklogRelations,
  type BacklogMetadataScope,
} from './metadata-codec.js';
import { idempotencyMarker as idempotencyMarkerOf, withIdempotencyMarker } from './idempotency.js';
import type { WorkItemId } from '../work-item/identity.js';

export interface BacklogCreatePlan {
  title: string;
  description: string;
  /** The lifecycle position. A PRD anchor is a container and has none. */
  state?: BacklogState;
  /** The role of the created item; `prd` marks an organizational parent. */
  kind?: BacklogKind;
  executionMode: BacklogExecutionMode;
  /** Canonical global identity of the organizational parent. */
  parentId?: WorkItemId;
  /** Canonical global identity of the execution base. */
  baseBacklogId?: WorkItemId;
  /** Canonical global identities this item waits for. */
  dependsOn: WorkItemId[];
  tags: string[];
  labels: string[];
  idempotencyMarker?: string;
  links: { parent?: BacklogItem; executionBase?: BacklogItem; dependencies: BacklogItem[] };
}

/** The provider surface a creation plan needs. */
export interface BacklogCreatePlanner {
  get(id: string): Promise<BacklogItem>;
}

/**
 * Resolve one relationship reference to a canonical global identity.
 *
 * A reference that names no project — a bare issue number — belongs to the
 * project the item is created in. The provider owns that project, so it is
 * the provider that passes the scope in; the plan never has to ask a wrapper
 * for it.
 */
function resolveReference(value: string, scope: BacklogMetadataScope): WorkItemId {
  return canonicalizeBacklogReference(value, scope);
}

/**
 * Plan the creation of one backlog item.
 *
 * The dry run and the real creation share this plan, so what an operator
 * previewed is exactly what the provider receives.
 */
export async function planBacklogCreate(
  provider: BacklogCreatePlanner,
  input: BacklogCreateInput,
  scope: BacklogMetadataScope,
): Promise<BacklogCreatePlan> {
  const title = input.title.trim();
  if (!title) throw new Error('backlog title must not be empty');
  const kind = input.kind;
  // A PRD anchor groups children and is never executed on its own, so it
  // defaults to the human-in-the-loop mode. Asking for an autonomous PRD is
  // a contradiction and is refused rather than silently downgraded.
  const executionMode = input.executionMode ?? (kind === 'prd' ? 'hitl' : 'afk');
  if (executionMode !== 'afk' && executionMode !== 'hitl') throw new Error(`invalid execution mode: ${executionMode}`);
  if (kind === 'prd' && executionMode === 'afk') {
    throw new Error('a PRD parent cannot be autonomous; it is an organizational anchor');
  }
  const parentId = input.parentId === undefined ? undefined : resolveReference(input.parentId, scope);
  const baseBacklogId = input.baseBacklogId === undefined ? undefined : resolveReference(input.baseBacklogId, scope);
  const dependsOn = [...new Set((input.dependsOn ?? []).map(id => resolveReference(id, scope)))];
  const tags = [...new Set((input.tags ?? []).map(validateBusinessTag))];
  if (input.idempotencyKey !== undefined && !input.idempotencyKey.trim()) throw new Error('idempotency key must not be empty');
  const idempotencyMarker = input.idempotencyKey === undefined ? undefined
    : idempotencyMarkerOf(input.idempotencyKey);
  // A PRD anchor is a container, not a work item in a lifecycle: it gets no
  // stage label at all. Its role label says what it is, and its mode label
  // says it never runs by itself.
  const state: BacklogState | undefined = kind === 'prd' ? undefined : 'ready';
  const roleLabels = kind === 'prd'
    ? [BACKLOG_KIND_LABELS.prd]
    : [BACKLOG_METADATA.stateLabels.ready];
  const labels = [
    ...roleLabels,
    BACKLOG_METADATA.executionModeLabels[executionMode], ...tags,
    ...encodeBacklogRelations({ parentId, baseBacklogId, dependsOn }, scope),
  ];
  const [parent, executionBase, dependencies] = await Promise.all([
    parentId ? provider.get(parentId) : undefined,
    baseBacklogId ? provider.get(baseBacklogId) : undefined,
    Promise.all(dependsOn.map(id => provider.get(id))),
  ]);
  const links = { parent, executionBase, dependencies };
  const body = renderBacklogDescription(input.description, links);
  return { title, description: idempotencyMarker === undefined ? body : withIdempotencyMarker(body, idempotencyMarker), state, kind, executionMode, parentId, baseBacklogId, dependsOn, tags, labels,
    idempotencyMarker, links };
}

/**
 * The human-readable link label of a backlog item.
 *
 * The issue number is what a reader recognizes; the canonical identity is
 * machinery, not something to put in a body a human reads.
 */
function linkLabel(item: BacklogItem): string {
  return `#${item.issueNumber ?? item.id}`;
}

const BACKLOG_LINKS_HEADING = '## Backlog Links';

/**
 * The bullets AFK owns inside the links section.
 *
 * A body may already carry the section — a manifest author can write one — and
 * AFK's own entries have to replace whatever stood there before, not sit next
 * to it. A stale entry is worse than a missing one: it points somewhere the
 * reader is expected to follow.
 */
const MANAGED_LINK_PREFIXES = ['- This backlog:', '- Parent backlog:', '- Execution base:', '- Depends on:'];

export function renderBacklogDescription(
  description: string,
  links: { parent?: BacklogItem; executionBase?: BacklogItem; dependencies: BacklogItem[]; self?: BacklogItem },
): string {
  const entries = [
    ...(links.self?.webUrl ? [`- This backlog: [${linkLabel(links.self)}](${links.self.webUrl})`] : []),
    ...(links.parent?.webUrl ? [`- Parent backlog: [${linkLabel(links.parent)}](${links.parent.webUrl})`] : []),
    ...(links.executionBase?.webUrl ? [`- Execution base: [${linkLabel(links.executionBase)}](${links.executionBase.webUrl})`] : []),
    ...links.dependencies.flatMap(item => item.webUrl ? [`- Depends on: [${linkLabel(item)}](${item.webUrl})`] : []),
  ];
  if (entries.length === 0) return description;

  const headingIndex = description.indexOf(BACKLOG_LINKS_HEADING);
  if (headingIndex < 0) {
    return `${description.trimEnd()}\n\n${BACKLOG_LINKS_HEADING}\n\n${entries.join('\n')}\n`;
  }

  // The section already exists: write AFK's entries into it instead of
  // appending a second section with the same name.
  const before = description.slice(0, headingIndex);
  const after = description.slice(headingIndex + BACKLOG_LINKS_HEADING.length);
  const nextHeading = after.search(/\n##\s/);
  const section = (nextHeading < 0 ? after : after.slice(0, nextHeading)).trim();
  const rest = nextHeading < 0 ? '' : after.slice(nextHeading);

  const kept = section
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.startsWith('- ') && !MANAGED_LINK_PREFIXES.some(prefix => line.startsWith(prefix)));
  const merged = [...kept, ...entries.filter(entry => !kept.includes(entry))];
  return `${before}${BACKLOG_LINKS_HEADING}\n\n${merged.join('\n')}\n${rest}`;
}

/**
 * The Git branch an execution starts from.
 *
 * An unfinished base backlog selects its own branch only when it belongs to
 * the same repository as the item being executed. A branch in another
 * repository is not a valid Git baseline for this checkout, so cross-repository
 * base references remain recorded as global work-item links while execution
 * uses the target repository's configured branch. Completed or merged bases
 * also fall back to the configured branch.
 */
export async function resolveBacklogExecutionBase(
  provider: Pick<BacklogManagementProvider, 'get'>, item: BacklogItem, fallback: string,
): Promise<string> {
  if (!item.baseBacklogId) return fallback;
  if (/^prd-[1-9]\d*$/.test(item.baseBacklogId)) return `prd/${item.baseBacklogId.slice(4)}`;
  const base = await provider.get(item.baseBacklogId);
  const baseRepository = base.providerRef.slice(0, base.providerRef.lastIndexOf('#'));
  const itemRepository = item.providerRef.slice(0, item.providerRef.lastIndexOf('#'));
  if (baseRepository !== itemRepository) return fallback;
  return base.state === 'done' || base.changeRequest?.state === 'merged' ? fallback : base.branchName;
}
