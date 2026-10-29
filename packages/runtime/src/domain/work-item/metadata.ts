import { BACKLOG_METADATA } from '../backlog/initialization.js';
import type { BacklogExecutionMode, BacklogState } from '../backlog/index.js';
import { deriveBacklogBranchName } from '../backlog/index.js';
import { decodeBacklogMetadata } from '../backlog/metadata-codec.js';
import { formatWorkItemId } from './identity.js';
import type { GlobalWorkItem, ProviderProjectRef } from './types.js';
import type { ProviderIssue } from './provider-types.js';

const stateLabels = BACKLOG_METADATA.stateLabels;
const modeLabels = BACKLOG_METADATA.executionModeLabels;

/**
 * Project one provider issue onto the global work item model.
 *
 * The relationship edges are read by the backlog metadata codec, the same
 * codec the tracker adapter uses, so a parent edge means the same thing in the
 * inventory and in the provider.
 *
 * The inventory scan is read leniently: one issue with malformed metadata
 * must not hide every other issue of every project.
 */
export function toGlobalWorkItem(project: ProviderProjectRef, issue: ProviderIssue): GlobalWorkItem {
  const id = formatWorkItemId({
    platform: project.platform,
    projectKey: project.projectKey,
    issueNumber: issue.issueNumber,
  });
  const metadata = decodeBacklogMetadata(issue.labels, {
    platform: project.platform,
    projectKey: project.projectKey,
  });
  const labeledState = Object.entries(stateLabels)
    .find(([, label]) => issue.labels.includes(label))?.[0] as BacklogState | undefined;
  const labeledMode = Object.entries(modeLabels)
    .find(([, label]) => issue.labels.includes(label))?.[0] as BacklogExecutionMode | undefined;
  const kind = metadata.kind;
  // An issue AFK manages carries a mode label and either a lifecycle label or
  // a role label. A manual issue may carry neither, and the difference
  // decides whether its state is a recorded fact or a derived default.
  const managed = labeledMode !== undefined && (labeledState !== undefined || kind !== undefined);
  const closed = issue.state === 'closed';
  // A PRD anchor is a container, not a work item in a lifecycle: it has no
  // position of its own. A closed one still reads as done.
  const state = kind === 'prd'
    ? (closed ? 'done' : undefined)
    : closed ? 'done' : labeledState ?? 'blocked';
  const executionMode = labeledMode ?? 'hitl';

  return {
    id,
    issueNumber: issue.issueNumber,
    project,
    title: issue.title,
    description: issue.description,
    managed,
    executionEligible: kind !== 'prd' && managed
      && (state === 'ready' || state === 'rework'),
    state,
    ...(kind === undefined ? {} : { kind }),
    executionMode,
    parentId: metadata.relations.parentId,
    dependsOn: metadata.relations.dependsOn,
    tags: metadata.tags,
    branchName: deriveBacklogBranchName(String(issue.issueNumber)),
    providerRef: id,
    webUrl: issue.webUrl,
    updatedAt: issue.updatedAt,
  };
}
