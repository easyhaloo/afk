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

import { BACKLOG_METADATA } from './initialization.js';
import { extractBacklogTags } from './tags.js';
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
  return {
    state,
    executionMode,
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
