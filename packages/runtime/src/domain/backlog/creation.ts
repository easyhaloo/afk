import { createHash } from 'node:crypto';
import type { BacklogCreateInput, BacklogItem, BacklogManagementProvider } from './index.js';
import { BACKLOG_METADATA } from './initialization.js';
import { validateBusinessTag } from './tags.js';
import { parseWorkItemId } from '../work-item/identity.js';

export function canonicalBacklogReference(value: string): string {
  const normalized = value.trim();
  if (normalized.includes(':')) return parseWorkItemId(normalized).id;
  const issueId = Number(normalized);
  if (!/^[0-9]+$/.test(normalized) || !Number.isSafeInteger(issueId) || issueId <= 0) {
    throw new Error(`tracker backlog id must be a positive integer: ${value}`);
  }
  return String(issueId);
}

export function validateBacklogRelations(labels: readonly string[], selfIds: readonly string[] = [], allowLegacyBase = false): void {
  const relations = labels.filter(label => ['parent::', 'base::', 'depends-on::', 'depends_on::'].some(prefix => label.startsWith(prefix)))
    .map(label => label.replace(/^depends_on::/, 'depends-on::'));
  if (new Set(relations).size !== relations.length
    || ['parent::', 'base::'].some(prefix => relations.filter(label => label.startsWith(prefix)).length > 1)) {
    throw new Error('invalid backlog relationship metadata: duplicate parent, base, or dependency');
  }
  for (const label of relations) {
    const value = label.slice(label.indexOf('::') + 2);
    if (allowLegacyBase && /^base::prd-[1-9]\d*$/.test(label)) continue;
    if (canonicalBacklogReference(value) !== value || selfIds.includes(value)) {
      throw new Error(`invalid backlog relationship metadata: ${label} must reference another canonical backlog ID`);
    }
  }
}

export async function planBacklogCreate(provider: Pick<BacklogManagementProvider, 'get'>, input: BacklogCreateInput) {
  const title = input.title.trim();
  if (!title) throw new Error('backlog title must not be empty');
  const state = input.stage ?? 'ready';
  if (state !== 'ready' && state !== 'prd') throw new Error(`invalid creation stage: ${state}`);
  const executionMode = input.executionMode ?? 'afk';
  if (executionMode !== 'afk' && executionMode !== 'hitl') throw new Error(`invalid execution mode: ${executionMode}`);
  const parentId = input.parentId === undefined ? undefined : canonicalBacklogReference(input.parentId);
  const baseBacklogId = input.baseBacklogId === undefined ? undefined : canonicalBacklogReference(input.baseBacklogId);
  const dependsOn = [...new Set((input.dependsOn ?? []).map(canonicalBacklogReference))];
  const tags = [...new Set((input.tags ?? []).map(validateBusinessTag))];
  if (input.idempotencyKey !== undefined && !input.idempotencyKey.trim()) throw new Error('idempotency key must not be empty');
  const idempotencyLabel = input.idempotencyKey === undefined ? undefined
    : `idempotency::${createHash('sha256').update(input.idempotencyKey).digest('hex')}`;
  const labels = [
    BACKLOG_METADATA.stateLabels[state], BACKLOG_METADATA.executionModeLabels[executionMode], ...tags,
    ...(parentId ? [`parent::${parentId}`] : []),
    ...(baseBacklogId ? [`base::${baseBacklogId}`] : []),
    ...dependsOn.map(id => `depends-on::${id}`),
    ...(idempotencyLabel ? [idempotencyLabel] : []),
  ];
  validateBacklogRelations(labels);
  const [parent, executionBase, dependencies] = await Promise.all([
    parentId ? provider.get(parentId) : undefined,
    baseBacklogId ? provider.get(baseBacklogId) : undefined,
    Promise.all(dependsOn.map(id => provider.get(id))),
  ]);
  const links = { parent, executionBase, dependencies };
  return { title, description: renderBacklogDescription(input.description, links), state, executionMode, parentId, baseBacklogId, dependsOn, tags, labels,
    idempotencyLabel, links };
}

export function renderBacklogDescription(
  description: string,
  links: { parent?: BacklogItem; executionBase?: BacklogItem; dependencies: BacklogItem[]; self?: BacklogItem },
): string {
  const entries = [
    ...(links.self?.webUrl ? [`- This backlog: [#${links.self.id}](${links.self.webUrl})`] : []),
    ...(links.parent?.webUrl ? [`- Parent backlog: [#${links.parent.id}](${links.parent.webUrl})`] : []),
    ...(links.executionBase?.webUrl ? [`- Execution base: [#${links.executionBase.id}](${links.executionBase.webUrl})`] : []),
    ...links.dependencies.flatMap(item => item.webUrl ? [`- Depends on: [#${item.id}](${item.webUrl})`] : []),
  ];
  if (entries.length === 0) return description;
  return `${description.trimEnd()}\n\n## Backlog Links\n\n${entries.join('\n')}\n`;
}

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
