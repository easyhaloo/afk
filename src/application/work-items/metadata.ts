import { BACKLOG_METADATA } from '../../domain/backlog/initialization';
import type { BacklogExecutionMode, BacklogState } from '../../domain/backlog';
import { deriveBacklogBranchName } from '../../domain/backlog';
import { extractBacklogTags } from '../../domain/backlog/tags';
import { formatWorkItemId, parseWorkItemId } from '../../domain/work-item/identity';
import type { GlobalWorkItem, ProviderProjectRef, WorkItemId } from '../../domain/work-item/types';
import type { ProviderIssue } from './types';

const stateLabels = BACKLOG_METADATA.stateLabels;
const modeLabels = BACKLOG_METADATA.executionModeLabels;

export function toGlobalWorkItem(project: ProviderProjectRef, issue: ProviderIssue): GlobalWorkItem {
  const id = formatWorkItemId({
    platform: project.platform,
    projectKey: project.projectKey,
    issueNumber: issue.issueNumber,
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
      && (state === 'ready' || state === 'rework')
      && executionMode === 'afk',
    state,
    executionMode,
    parentId: relationId(project, issue.labels, ['parent::']),
    dependsOn: relationIds(project, issue.labels, ['depends-on::', 'depends_on::']),
    tags: extractBacklogTags(issue.labels),
    branchName: deriveBacklogBranchName(String(issue.issueNumber)),
    providerRef: id,
    webUrl: issue.webUrl,
  };
}

function relationId(
  project: ProviderProjectRef,
  labels: readonly string[],
  prefixes: readonly string[],
): WorkItemId | undefined {
  for (const label of labels) {
    const prefix = prefixes.find(candidate => label.startsWith(candidate));
    if (!prefix) continue;
    const parsed = parseRelationValue(project, label.slice(prefix.length));
    if (parsed) return parsed;
  }
  return undefined;
}

function relationIds(
  project: ProviderProjectRef,
  labels: readonly string[],
  prefixes: readonly string[],
): WorkItemId[] {
  const values = labels.flatMap(label => {
    const prefix = prefixes.find(candidate => label.startsWith(candidate));
    if (!prefix) return [];
    const parsed = parseRelationValue(project, label.slice(prefix.length));
    return parsed ? [parsed] : [];
  });
  return [...new Set(values)];
}

function parseRelationValue(project: ProviderProjectRef, value: string): WorkItemId | undefined {
  if (/^[1-9]\d*$/.test(value)) {
    return formatWorkItemId({
      platform: project.platform,
      projectKey: project.projectKey,
      issueNumber: Number(value),
    });
  }
  try {
    return parseWorkItemId(value).id;
  } catch {
    return undefined;
  }
}
