/**
 * The single codec for AFK backlog metadata.
 *
 * Provider adapters persist the backlog lifecycle and its relationships as
 * issue labels. This module owns every rule about how those labels are read
 * and written: which prefix carries which relation, how a reference becomes a
 * canonical work item identity, and which combinations are rejected.
 *
 * Adapters must not parse labels on their own. Two parsers is how two
 * providers end up disagreeing about what `parent::` means, and the backlog
 * graph then silently loses an edge.
 */

import { BACKLOG_KIND_LABELS, BACKLOG_LABEL_PREFIX, BACKLOG_METADATA } from './initialization.js';
import { extractBacklogTags } from './tags.js';
import type { BacklogKind } from './index.js';
import type { BacklogExecutionMode, BacklogState } from './index.js';
import { formatWorkItemId, parseWorkItemId } from '../work-item/identity.js';
import type { WorkItemId, WorkItemScope } from '../work-item/identity.js';

/** Label prefixes owned by this codec. */
export const BACKLOG_RELATION_PREFIX = {
  parent: 'parent::',
  base: 'base::',
  dependsOn: 'depends-on::',
} as const;

/** Historical spelling still readable on providers that carry it. */
export const LEGACY_DEPENDS_ON_PREFIX = 'depends_on::';

/**
 * Historical execution base marker. `base::prd-N` never named an issue; it
 * selected the `prd/N` branch of the repository that owned the PRD.
 */
export const LEGACY_BASE_PATTERN = /^prd-([1-9]\d*)$/;

/** A reference written as a plain issue number. */
const INTEGER_REFERENCE = /^[1-9]\d*$/;
/** A reference written with leading zeros; accepted on input, never stored. */
const PADDED_INTEGER_REFERENCE = /^[0-9]+$/;

/**
 * The project a bare reference resolves against.
 *
 * A relationship label may address an issue in another repository, so the
 * scope is only the fallback for references that name no project at all.
 */
export type BacklogMetadataScope = WorkItemScope;

/** The relationship edges of one backlog item, in canonical identity form. */
export interface BacklogRelations {
  /** Organizational grouping only; it never selects a Git execution base. */
  parentId?: WorkItemId;
  /** Explicit unmerged execution baseline for stacked work. */
  baseBacklogId?: WorkItemId;
  /** Legacy `prd-N` execution base token; it names a branch, not an issue. */
  legacyBaseRef?: string;
  /** All work items that must reach done before this item becomes runnable. */
  dependsOn: WorkItemId[];
}

/** Everything the codec reads out of one issue's labels. */
export interface BacklogMetadata {
  state?: BacklogState;
  executionMode?: BacklogExecutionMode;
  /** The role of the item; `prd` marks an organizational parent. */
  kind?: BacklogKind;
  relations: BacklogRelations;
  /** Provider-neutral business tags. */
  tags: string[];
}

export interface BacklogMetadataOptions {
  /**
   * Reject malformed, duplicate or self-referencing metadata instead of
   * dropping the offending edge.
   *
   * A single issue's metadata is read fail-closed: an item whose edges cannot
   * be trusted must not be scheduled. A whole-project inventory scan is read
   * leniently: one bad issue must not hide every other issue.
   */
  strict?: boolean;
  /** Accept the legacy `base::prd-N` execution base token. */
  allowLegacyBase?: boolean;
  /** Canonical identity of the item being decoded; a relation to it is invalid. */
  selfId?: WorkItemId;
}

/** True for every label that carries a relationship edge. */
export function isBacklogRelationLabel(label: string): boolean {
  return label.startsWith(BACKLOG_RELATION_PREFIX.parent)
    || label.startsWith(BACKLOG_RELATION_PREFIX.base)
    || label.startsWith(BACKLOG_RELATION_PREFIX.dependsOn)
    || label.startsWith(LEGACY_DEPENDS_ON_PREFIX);
}

function normalizeRelationLabel(label: string): string {
  return label.startsWith(LEGACY_DEPENDS_ON_PREFIX)
    ? `${BACKLOG_RELATION_PREFIX.dependsOn}${label.slice(LEGACY_DEPENDS_ON_PREFIX.length)}`
    : label;
}

/**
 * Canonicalize one relationship reference.
 *
 * A reference is either a plain issue number in the owning project or a
 * canonical global work item identity. A padded issue number is accepted here
 * because this is the boundary where operator input arrives; the stored label
 * always carries the canonical form.
 */
export function canonicalizeBacklogReference(value: string, scope: BacklogMetadataScope): WorkItemId {
  const normalized = value.trim();
  if (!normalized) throw new Error('backlog relationship reference must not be empty');
  if (PADDED_INTEGER_REFERENCE.test(normalized)) {
    const issueNumber = Number(normalized);
    if (!Number.isSafeInteger(issueNumber) || issueNumber <= 0) {
      throw new Error(`invalid backlog relationship reference: ${value}`);
    }
    return formatWorkItemId({ platform: scope.platform, projectKey: scope.projectKey, issueNumber });
  }
  try {
    return parseWorkItemId(normalized).id;
  } catch {
    throw new Error(`invalid backlog relationship reference: ${value}`);
  }
}

/**
 * Read the relationship edges out of provider labels.
 *
 * A stored reference must already be canonical: a plain issue number without
 * leading zeros, or a canonical global work item identity. Anything else is
 * malformed metadata rather than a reference to repair.
 */
export function decodeBacklogRelations(
  labels: readonly string[],
  scope: BacklogMetadataScope,
  options: BacklogMetadataOptions = {},
): BacklogRelations {
  const relationLabels = labels.filter(isBacklogRelationLabel).map(normalizeRelationLabel);
  const unique = [...new Set(relationLabels)];
  const parentLabels = unique.filter(label => label.startsWith(BACKLOG_RELATION_PREFIX.parent));
  const baseLabels = unique.filter(label => label.startsWith(BACKLOG_RELATION_PREFIX.base));
  const dependencyLabels = unique.filter(label => label.startsWith(BACKLOG_RELATION_PREFIX.dependsOn));
  if (options.strict
    && (relationLabels.length !== unique.length || parentLabels.length > 1 || baseLabels.length > 1)) {
    throw new Error('invalid backlog relationship metadata: duplicate parent, base, or dependency');
  }

  const relations: BacklogRelations = { dependsOn: [] };

  const parentLabel = parentLabels[0];
  if (parentLabel) {
    const reference = decodeReference(parentLabel.slice(BACKLOG_RELATION_PREFIX.parent.length), scope, options, 'parent');
    if (reference) relations.parentId = reference;
  }

  const baseLabel = baseLabels[0];
  if (baseLabel) {
    const value = baseLabel.slice(BACKLOG_RELATION_PREFIX.base.length);
    if (LEGACY_BASE_PATTERN.test(value)) {
      if (!options.allowLegacyBase) {
        if (options.strict) {
          throw new Error(`invalid backlog relationship metadata: ${baseLabel} uses the legacy PRD base form`);
        }
      } else {
        relations.legacyBaseRef = value;
      }
    } else {
      const reference = decodeReference(value, scope, options, 'base');
      if (reference) relations.baseBacklogId = reference;
    }
  }

  for (const label of dependencyLabels) {
    const reference = decodeReference(label.slice(BACKLOG_RELATION_PREFIX.dependsOn.length), scope, options, 'dependency');
    if (reference && !relations.dependsOn.includes(reference)) relations.dependsOn.push(reference);
  }

  return relations;
}

function decodeReference(
  value: string,
  scope: BacklogMetadataScope,
  options: BacklogMetadataOptions,
  kind: 'parent' | 'base' | 'dependency',
): WorkItemId | undefined {
  let reference: WorkItemId;
  if (INTEGER_REFERENCE.test(value)) {
    reference = formatWorkItemId({ platform: scope.platform, projectKey: scope.projectKey, issueNumber: Number(value) });
  } else {
    try {
      reference = parseWorkItemId(value).id;
    } catch {
      if (options.strict) {
        throw new Error(`invalid backlog relationship metadata: ${kind} reference ${value} is not a canonical backlog ID`);
      }
      return undefined;
    }
  }
  if (options.selfId && reference === options.selfId) {
    if (options.strict) {
      throw new Error(`invalid backlog relationship metadata: ${kind} reference ${value} points at the item itself`);
    }
    return undefined;
  }
  return reference;
}

/** Read the lifecycle, the relationships and the business tags of one issue. */
export function decodeBacklogMetadata(
  labels: readonly string[],
  scope: BacklogMetadataScope,
  options: BacklogMetadataOptions = {},
): BacklogMetadata {
  const state = Object.entries(BACKLOG_METADATA.stateLabels)
    .find(([, label]) => labels.includes(label))?.[0] as BacklogState | undefined;
  const executionMode = Object.entries(BACKLOG_METADATA.executionModeLabels)
    .find(([, label]) => labels.includes(label))?.[0] as BacklogExecutionMode | undefined;
  const kind = Object.entries(BACKLOG_KIND_LABELS)
    .find(([, label]) => labels.includes(label))?.[0] as BacklogKind | undefined;
  return {
    state,
    executionMode,
    kind,
    relations: decodeBacklogRelations(labels, scope, options),
    tags: extractBacklogTags(labels),
  };
}

/** Write relationship edges back into provider labels. */
export function encodeBacklogRelations(relations: BacklogRelations): string[] {
  return [
    ...(relations.parentId ? [`${BACKLOG_RELATION_PREFIX.parent}${relations.parentId}`] : []),
    ...(relations.baseBacklogId ? [`${BACKLOG_RELATION_PREFIX.base}${relations.baseBacklogId}`] : []),
    ...relations.dependsOn.map(id => `${BACKLOG_RELATION_PREFIX.dependsOn}${id}`),
  ];
}

/** The label changes one relationship edit asks for. */
export interface BacklogLabelDelta {
  add: string[];
  remove: string[];
}

/**
 * One edit to the relationship edges of a backlog item.
 *
 * The edit names the edges it touches; every other edge of the item stays as
 * it is. A reference is either a plain issue number in the owning project or
 * a canonical global work item identity.
 */
export interface BacklogRelationUpdate {
  /** Point the item at a parent, replacing the parent edge it had. */
  parent?: string;
  /** Drop the parent edge. */
  clearParent?: boolean;
  /** Point the item at an execution baseline, replacing the edge it had. */
  base?: string;
  /** Drop the execution baseline edge. */
  clearBase?: boolean;
  /** Dependencies to add. */
  addDependsOn?: string[];
  /** Dependencies to drop. */
  removeDependsOn?: string[];
}

/**
 * Plan the label changes that apply a relationship edit.
 *
 * The edit is expressed in references, not in labels: a bare issue number is
 * resolved against the scope of the project that owns the issue, and the
 * canonical form is what gets written. An edge the edit does not mention is
 * left alone — including an edge this codec cannot parse, because an
 * operator who wants that edge gone asks for it by name.
 *
 * The result is a delta, not a label set: the provider adds and removes the
 * minimum needed to carry the edit, and no other label of the issue moves.
 */
export function planRelationLabelDelta(
  labels: readonly string[],
  update: BacklogRelationUpdate,
  scope: BacklogMetadataScope,
  options: { selfId?: WorkItemId } = {},
): BacklogLabelDelta {
  if (update.parent !== undefined && update.clearParent) {
    throw new Error('a backlog relation update cannot set and clear the parent edge at once');
  }
  if (update.base !== undefined && update.clearBase) {
    throw new Error('a backlog relation update cannot set and clear the execution base edge at once');
  }
  const add = new Set<string>();
  const remove = new Set<string>();
  const relationLabels = labels.filter(isBacklogRelationLabel);

  const parentLabels = relationLabels.filter(label => label.startsWith(BACKLOG_RELATION_PREFIX.parent));
  if (update.parent !== undefined) {
    const desired = `${BACKLOG_RELATION_PREFIX.parent}${relationReference(update.parent, scope, options.selfId, 'parent')}`;
    add.add(desired);
    for (const label of parentLabels) if (label !== desired) remove.add(label);
  } else if (update.clearParent) {
    for (const label of parentLabels) remove.add(label);
  } else {
    for (const label of parentLabels) add.add(label);
  }

  const baseLabels = relationLabels.filter(label => label.startsWith(BACKLOG_RELATION_PREFIX.base));
  if (update.base !== undefined) {
    const desired = `${BACKLOG_RELATION_PREFIX.base}${relationReference(update.base, scope, options.selfId, 'base')}`;
    add.add(desired);
    for (const label of baseLabels) if (label !== desired) remove.add(label);
  } else if (update.clearBase) {
    for (const label of baseLabels) remove.add(label);
  } else {
    for (const label of baseLabels) add.add(label);
  }

  const dependencyLabels = relationLabels.filter(label =>
    label.startsWith(BACKLOG_RELATION_PREFIX.dependsOn) || label.startsWith(LEGACY_DEPENDS_ON_PREFIX));
  const dropped = new Set<string>();
  for (const reference of update.removeDependsOn ?? []) {
    dropped.add(relationReference(reference, scope, options.selfId, 'dependency'));
  }
  for (const label of dependencyLabels) {
    const canonical = normalizeRelationLabel(label);
    const reference = canonical.slice(BACKLOG_RELATION_PREFIX.dependsOn.length);
    if (dropped.has(reference)) {
      remove.add(label);
      continue;
    }
    // The legacy spelling is rewritten in the canonical form.
    if (canonical !== label) {
      remove.add(label);
      add.add(canonical);
      continue;
    }
    add.add(label);
  }
  for (const reference of update.addDependsOn ?? []) {
    const canonical = relationReference(reference, scope, options.selfId, 'dependency');
    if (dropped.has(canonical)) continue;
    add.add(`${BACKLOG_RELATION_PREFIX.dependsOn}${canonical}`);
  }

  return {
    add: [...add].filter(label => !labels.includes(label)),
    remove: [...remove].filter(label => labels.includes(label)),
  };
}

/**
 * Canonicalize one reference of a relationship edit.
 *
 * A reference to the item itself is rejected: an item cannot be its own
 * parent, its own execution baseline or its own dependency.
 */
function relationReference(
  value: string,
  scope: BacklogMetadataScope,
  selfId: WorkItemId | undefined,
  kind: 'parent' | 'base' | 'dependency',
): WorkItemId {
  const reference = canonicalizeBacklogReference(value, scope);
  if (selfId && reference === selfId) {
    throw new Error(`invalid backlog relationship: ${kind} reference ${value} points at the item itself`);
  }
  return reference;
}

/**
 * Plan the label changes that give an item a role.
 *
 * An organizational anchor is not a work item in a lifecycle: it carries the
 * role label, no stage label at all, and the human-in-the-loop mode, because
 * an anchor never runs by itself. Every other label of the issue — the
 * business tags, the relationships, the idempotency marker — is left where it
 * is, so giving a role never disturbs the graph the item belongs to.
 */
export function planRoleLabelDelta(
  labels: readonly string[],
  kind: BacklogKind,
): BacklogLabelDelta {
  const roleLabel = BACKLOG_KIND_LABELS[kind];
  const modeLabel = BACKLOG_METADATA.executionModeLabels.hitl;
  const desired = new Set([roleLabel, modeLabel]);
  const remove = new Set<string>();
  for (const label of labels) {
    // A label the edit asks for is never removed: a provider applies the
    // removals first, and a label in both lists would simply disappear.
    if (desired.has(label)) continue;
    if (label.startsWith(BACKLOG_LABEL_PREFIX.kind)) remove.add(label);
    if (label.startsWith(BACKLOG_LABEL_PREFIX.state)) remove.add(label);
    if (label.startsWith(BACKLOG_LABEL_PREFIX.mode)) remove.add(label);
  }
  return {
    add: [...desired].filter(label => !labels.includes(label)),
    remove: [...remove].filter(label => labels.includes(label)),
  };
}

/**
 * Plan the label changes that switch who runs an item.
 *
 * The execution mode is the only thing the edit touches: the stage, the role,
 * the business tags and the relationships of the item stay exactly where they
 * are, so an operator can hand an item to a human or back to AFK without
 * disturbing the graph it belongs to.
 */
export function planModeLabelDelta(
  labels: readonly string[],
  mode: BacklogExecutionMode,
): BacklogLabelDelta {
  const modeLabel = BACKLOG_METADATA.executionModeLabels[mode];
  return {
    add: labels.includes(modeLabel) ? [] : [modeLabel],
    remove: labels.filter(label =>
      label !== modeLabel && label.startsWith(BACKLOG_LABEL_PREFIX.mode)),
  };
}
