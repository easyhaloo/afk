import type { BacklogExecutionMode, BacklogState } from '../backlog-mapping.js';
import type { TrackerIssueState } from '../tracker/types.js';
import { formatWorkItemId, parseWorkItemId } from '../work-items/identity.js';
import type { WorkItemId, WorkItemPlatform, ParsedWorkItemId } from '../work-items/identity.js';
import { BACKLOG_METADATA } from './initialization.js';

/**
 * The one grammar for backlog labels.
 *
 * A backlog item lives in a tracker as labels; every provider reads those
 * labels back into the same canonical fields.  Two providers used to read
 * the same labels through two different grammars — one naming issues by
 * project ("42"), the other by canonical work item id
 * ("github:acme/api#42") — so an id read from one provider never matched
 * the other and the list came back empty without an error.
 *
 * This module owns the grammar once: the vocabulary, the projection of
 * labels onto canonical fields, the relation labels, and the identity
 * policy that decides how an id is written and whether an unqualified id
 * names one identity or many.
 */

/** The project an unqualified issue number is relative to. */
export interface BacklogProjectScope {
  readonly platform: WorkItemPlatform;
  readonly projectKey: string;
}

/**
 * How one provider names the identities it publishes.
 *
 * `provider-local` — the provider reaches exactly one project (`scope`): an
 * id is that project's issue number ("42"), and an unqualified id names
 * exactly one identity.
 *
 * `work-item` — the provider reaches many projects: an id is a canonical
 * work item id ("github:acme/api#42"), and an unqualified id names an
 * unknown number of identities, so it is rejected instead of quietly
 * matching nothing.  `scope` is the project an unqualified relation *label*
 * is relative to; it is absent when the provider does not need one.
 */
export type BacklogIdentityPolicy =
  | { readonly kind: 'provider-local'; readonly scope: BacklogProjectScope }
  | { readonly kind: 'work-item'; readonly scope?: BacklogProjectScope };

/** An identity policy that can resolve an unqualified relation value. */
export type ScopedBacklogIdentityPolicy = BacklogIdentityPolicy & { readonly scope: BacklogProjectScope };

/** The issue states a tracker can report. */
export type BacklogIssueState = TrackerIssueState;

/**
 * The state an issue carries when no state label says otherwise.
 *
 * An issue without AFK workflow metadata is not AFK's to act on, so it reads
 * as blocked rather than ready.  The single-project provider used to default
 * it to `ready`, which made every unlabelled issue in a repository look
 * runnable.
 */
export const DEFAULT_BACKLOG_STATE: BacklogState = 'blocked';

/**
 * The execution mode an issue carries when no mode label says otherwise.
 *
 * `hitl` keeps an issue without AFK workflow metadata out of autonomous
 * execution.
 */
export const DEFAULT_BACKLOG_EXECUTION_MODE: BacklogExecutionMode = 'hitl';

/** The canonical fields a label set projects onto. */
export interface BacklogLabelProjection {
  readonly state: BacklogState;
  readonly executionMode: BacklogExecutionMode;
  /** The issue carries AFK workflow metadata: a state label and a mode label. */
  readonly managed: boolean;
  readonly executionEligible: boolean;
  readonly parentId?: WorkItemId;
  readonly baseBacklogId?: WorkItemId;
  readonly dependsOn: WorkItemId[];
}

const PARENT_PREFIX = 'parent::';
const BASE_PREFIX = 'base::';
const DEPENDS_ON_PREFIXES = ['depends-on::', 'depends_on::'] as const;

/**
 * Project a label set onto the canonical backlog fields.
 *
 * The relation ids are always canonical work item ids: that is the one
 * identity grammar.  How a provider *writes* them is the identity policy's
 * job (see `renderBacklogId`).
 */
export function projectBacklogLabels(
  labels: readonly string[],
  issue: BacklogIssueState,
  policy: ScopedBacklogIdentityPolicy,
): BacklogLabelProjection {
  const labeledState = labeledStateOf(labels);
  const labeledMode = labeledModeOf(labels);
  const managed = labeledState !== undefined && labeledMode !== undefined;
  const state = issue === 'closed' || issue === 'merged' ? 'done' : labeledState ?? DEFAULT_BACKLOG_STATE;
  const executionMode = labeledMode ?? DEFAULT_BACKLOG_EXECUTION_MODE;
  const parentId = firstRelationId(labels, policy, PARENT_PREFIX);
  const baseBacklogId = firstRelationId(labels, policy, BASE_PREFIX);
  const dependsOn = relationIds(labels, policy, DEPENDS_ON_PREFIXES);
  return {
    state,
    executionMode,
    managed,
    executionEligible: managed && (state === 'ready' || state === 'rework'),
    ...(parentId === undefined ? {} : { parentId }),
    ...(baseBacklogId === undefined ? {} : { baseBacklogId }),
    dependsOn,
  };
}

/**
 * Resolve the opaque filter argument into the identity it names.
 *
 * The argument reaches a provider as a plain string, so it carries its own
 * policy: a canonical work item id names one identity in every provider,
 * while an unqualified issue number names one identity only in a provider
 * that reaches a single project.  An argument the policy cannot resolve is
 * an error — a filter that quietly matched nothing is the failure this
 * module removes.
 */
export function resolveBacklogFilterId(argument: string, policy: BacklogIdentityPolicy): WorkItemId {
  const canonical = parseCanonicalId(argument);
  if (canonical) return canonical;
  const issueNumber = issueNumberOf(argument);
  if (issueNumber !== undefined) {
    if (policy.kind === 'provider-local') {
      try {
        return formatWorkItemId({
          platform: policy.scope.platform,
          projectKey: policy.scope.projectKey,
          issueNumber,
        });
      } catch {
        throw new Error(`backlog filter id "${argument}" is not a valid identity: expected platform:projectKey#issueNumber`);
      }
    }
    throw new Error(
      `backlog filter id "${argument}" is ambiguous: it names an issue number without a project, `
      + 'so it cannot select one work item across every project',
    );
  }
  throw new Error(`backlog filter id "${argument}" is not a valid identity: expected platform:projectKey#issueNumber`);
}

/**
 * Write an identity the way this provider publishes identities.
 *
 * A provider-local provider writes an identity of its own project as the
 * issue number; an identity of another project keeps its canonical form,
 * because no local number can name it.
 */
export function renderBacklogId(id: WorkItemId, policy: BacklogIdentityPolicy): string {
  if (policy.kind === 'work-item') return id;
  const parsed = parseCanonicalParts(id);
  if (!parsed) return id;
  if (parsed.platform !== policy.scope.platform || parsed.projectKey !== policy.scope.projectKey) return id;
  return String(parsed.issueNumber);
}

function labeledStateOf(labels: readonly string[]): BacklogState | undefined {
  for (const [state, label] of Object.entries(BACKLOG_METADATA.stateLabels)) {
    if (labels.includes(label)) return state as BacklogState;
  }
  return undefined;
}

function labeledModeOf(labels: readonly string[]): BacklogExecutionMode | undefined {
  for (const [mode, label] of Object.entries(BACKLOG_METADATA.executionModeLabels)) {
    if (labels.includes(label)) return mode as BacklogExecutionMode;
  }
  return undefined;
}

function firstRelationId(
  labels: readonly string[],
  policy: ScopedBacklogIdentityPolicy,
  prefix: string,
): WorkItemId | undefined {
  for (const label of labels) {
    if (!label.startsWith(prefix)) continue;
    const parsed = parseRelationValue(label.slice(prefix.length), policy);
    if (parsed) return parsed;
  }
  return undefined;
}

function relationIds(
  labels: readonly string[],
  policy: ScopedBacklogIdentityPolicy,
  prefixes: readonly string[],
): WorkItemId[] {
  const values = labels.flatMap(label => {
    const prefix = prefixes.find(candidate => label.startsWith(candidate));
    if (!prefix) return [];
    const parsed = parseRelationValue(label.slice(prefix.length), policy);
    return parsed ? [parsed] : [];
  });
  return [...new Set(values)];
}

/**
 * Read one relation value.
 *
 * An unqualified value is the issue number of the issue's own project; a
 * canonical value names the work item it spells out, in this project or in
 * another one.  A value that names neither is malformed and the relation is
 * dropped rather than carried as an opaque string.
 */
function parseRelationValue(value: string, policy: ScopedBacklogIdentityPolicy): WorkItemId | undefined {
  const canonical = parseCanonicalId(value);
  if (canonical) return canonical;
  const issueNumber = issueNumberOf(value);
  if (issueNumber === undefined) return undefined;
  try {
    return formatWorkItemId({
      platform: policy.scope.platform,
      projectKey: policy.scope.projectKey,
      issueNumber,
    });
  } catch {
    return undefined;
  }
}

/** The issue number an unqualified value names, when it names one. */
function issueNumberOf(value: string): number | undefined {
  if (!/^[1-9]\d*$/.test(value)) return undefined;
  const issueNumber = Number(value);
  return Number.isSafeInteger(issueNumber) ? issueNumber : undefined;
}

function parseCanonicalId(value: string): WorkItemId | undefined {
  return parseCanonicalParts(value)?.id;
}

function parseCanonicalParts(value: string): ParsedWorkItemId | undefined {
  try {
    return parseWorkItemId(value);
  } catch {
    return undefined;
  }
}
