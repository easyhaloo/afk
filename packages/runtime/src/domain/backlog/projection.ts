/**
 * The projection of one provider issue onto the backlog model.
 *
 * Every provider — the tracker adapter, the cross-project graph, the global
 * inventory — reads an issue and produces the same backlog item. The
 * projection is the only place that decides what a label means, so the
 * identity, the lifecycle and the relationship edges of one issue are the
 * same everywhere.
 */

import type { BacklogExecutionMode, BacklogItem, BacklogState } from './index.js';
import { BACKLOG_METADATA } from './initialization.js';
import { deriveBacklogBranchName } from './branch-name.js';
import { decodeBacklogMetadata, type BacklogMetadataScope } from './metadata-codec.js';
import { formatWorkItemId } from '../work-item/identity.js';

const MODE_LABELS: Record<BacklogExecutionMode, string> = BACKLOG_METADATA.executionModeLabels;

/** The provider facts a backlog item is projected from. */
export interface BacklogIssueView {
  issueNumber: number;
  title: string;
  description?: string;
  labels: readonly string[];
  state: 'opened' | 'closed' | 'merged';
  webUrl?: string;
}

/**
 * Project one provider issue onto the canonical backlog model.
 *
 * The identity is global, so the same issue number in two repositories stays
 * two different backlog items, and every relationship edge names the item it
 * points at unambiguously.
 *
 * The projection is fail-closed: an issue whose metadata cannot be trusted
 * must not be scheduled, so malformed relationship metadata is an error
 * rather than a silently dropped edge.
 */
export function projectBacklogItem(issue: BacklogIssueView, scope: BacklogMetadataScope): BacklogItem {
  const id = formatWorkItemId({ platform: scope.platform, projectKey: scope.projectKey, issueNumber: issue.issueNumber });
  const metadata = decodeBacklogMetadata(issue.labels, scope, {
    strict: true,
    allowLegacyBase: true,
    selfId: id,
  });
  const labeledState = metadata.state;
  const kind = metadata.kind;
  const closed = issue.state === 'closed' || issue.state === 'merged';
  // A PRD anchor is a container, not a work item in a lifecycle: it has no
  // position of its own. A closed one still reads as done, because the
  // provider closed it.
  const state = kind === 'prd' ? (closed ? 'done' : undefined) : closed ? 'done' : labeledState ?? 'ready';
  const executionMode: BacklogExecutionMode = issue.labels.includes(MODE_LABELS.afk) && !issue.labels.includes(MODE_LABELS.hitl) ? 'afk' : 'hitl';
  const hasModeLabel = metadata.executionMode !== undefined;
  // An issue AFK manages carries a mode label and either a lifecycle label or
  // a role label. A manual issue may carry neither, and the difference
  // decides whether its state is a recorded fact or a derived default.
  const managed = hasModeLabel && (labeledState !== undefined || kind !== undefined);
  // The role decides executability, never the state: an anchor is ready and
  // still never runs.
  const executionEligible = kind !== 'prd' && managed && (state === 'ready' || state === 'rework')
    && labeledState !== undefined;
  return {
    id, workItemId: id, issueNumber: issue.issueNumber, title: issue.title, description: issue.description, managed, executionEligible,
    ...(kind ? { kind } : {}),
    parentId: metadata.relations.parentId,
    baseBacklogId: metadata.relations.baseBacklogId ?? metadata.relations.legacyBaseRef,
    dependsOn: metadata.relations.dependsOn, state, executionMode, tags: metadata.tags,
    ...(labeledState ? { labeledState } : {}),
    branchName: deriveBacklogBranchName(String(issue.issueNumber)), providerRef: id,
    ...(issue.webUrl === undefined ? {} : { webUrl: issue.webUrl }),
  };
}

/** The lifecycle state a provider issue carries, without the item projection. */
export function backlogStateOf(labels: readonly string[]): BacklogState | undefined {
  return Object.entries(BACKLOG_METADATA.stateLabels)
    .find(([, label]) => labels.includes(label))?.[0] as BacklogState | undefined;
}
