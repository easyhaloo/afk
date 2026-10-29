import { createHash } from 'node:crypto';
import type { BacklogCreateInput, BacklogExecutionMode, BacklogItem, BacklogManagementProvider } from './index.js';
import { BACKLOG_METADATA } from './initialization.js';
import { validateBusinessTag } from './tags.js';
import {
  canonicalizeBacklogReference,
  encodeBacklogRelations,
  type BacklogMetadataScope,
} from './metadata-codec.js';
import type { WorkItemId } from '../work-item/identity.js';

export interface BacklogCreatePlan {
  title: string;
  description: string;
  state: 'ready' | 'prd';
  executionMode: BacklogExecutionMode;
  /** Canonical global identity of the organizational parent. */
  parentId?: WorkItemId;
  /** Canonical global identity of the execution base. */
  baseBacklogId?: WorkItemId;
  /** Canonical global identities this item waits for. */
  dependsOn: WorkItemId[];
  tags: string[];
  labels: string[];
  idempotencyLabel?: string;
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
  const state = input.stage ?? 'ready';
  if (state !== 'ready' && state !== 'prd') throw new Error(`invalid creation stage: ${state}`);
  const executionMode = input.executionMode ?? 'afk';
  if (executionMode !== 'afk' && executionMode !== 'hitl') throw new Error(`invalid execution mode: ${executionMode}`);
  const parentId = input.parentId === undefined ? undefined : resolveReference(input.parentId, scope);
  const baseBacklogId = input.baseBacklogId === undefined ? undefined : resolveReference(input.baseBacklogId, scope);
  const dependsOn = [...new Set((input.dependsOn ?? []).map(id => resolveReference(id, scope)))];
  const tags = [...new Set((input.tags ?? []).map(validateBusinessTag))];
  if (input.idempotencyKey !== undefined && !input.idempotencyKey.trim()) throw new Error('idempotency key must not be empty');
  const idempotencyLabel = input.idempotencyKey === undefined ? undefined
    : `idempotency::${createHash('sha256').update(input.idempotencyKey).digest('hex')}`;
  const labels = [
    BACKLOG_METADATA.stateLabels[state], BACKLOG_METADATA.executionModeLabels[executionMode], ...tags,
    ...encodeBacklogRelations({ parentId, baseBacklogId, dependsOn }),
    ...(idempotencyLabel ? [idempotencyLabel] : []),
  ];
  const [parent, executionBase, dependencies] = await Promise.all([
    parentId ? provider.get(parentId) : undefined,
    baseBacklogId ? provider.get(baseBacklogId) : undefined,
    Promise.all(dependsOn.map(id => provider.get(id))),
  ]);
  const links = { parent, executionBase, dependencies };
  return { title, description: renderBacklogDescription(input.description, links), state, executionMode, parentId, baseBacklogId, dependsOn, tags, labels,
    idempotencyLabel, links };
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
  return `${description.trimEnd()}\n\n## Backlog Links\n\n${entries.join('\n')}\n`;
}

/**
 * The Git branch an execution starts from.
 *
 * An unfinished base backlog selects its own branch; a completed or merged
 * base falls back to the configured branch. The legacy `prd-N` base selects
 * the `prd/N` branch of the repository that owned the PRD.
 */
export async function resolveBacklogExecutionBase(
  provider: Pick<BacklogManagementProvider, 'get'>, item: BacklogItem, fallback: string,
): Promise<string> {
  if (!item.baseBacklogId) return fallback;
  if (/^prd-[1-9]\d*$/.test(item.baseBacklogId)) return `prd/${item.baseBacklogId.slice(4)}`;
  const base = await provider.get(item.baseBacklogId);
  if (base.providerRef.slice(0, base.providerRef.lastIndexOf('#')) !== item.providerRef.slice(0, item.providerRef.lastIndexOf('#'))) {
    throw new Error('execution base must belong to the same repository; use an execution manifest for multiple repositories');
  }
  return base.state === 'done' || base.changeRequest?.state === 'merged' ? fallback : base.branchName;
}
