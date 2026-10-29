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
  const managed = labeledState !== undefined && labeledMode !== undefined;
  const state = issue.state === 'closed' ? 'done' : labeledState ?? 'blocked';
  const executionMode = labeledMode ?? 'hitl';

  return {
    id,
    issueNumber: issue.issueNumber,
    project,
    title: issue.title,
    description: issue.description,
    managed,
    executionEligible: managed
      && (state === 'ready' || state === 'rework'),
    state,
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
