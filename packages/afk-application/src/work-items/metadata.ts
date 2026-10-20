import { deriveBacklogBranchName } from '../backlog/model.js';
import { extractBacklogTags } from '../backlog/tags.js';
import { formatWorkItemId } from './identity.js';
import type { GlobalWorkItem, ProviderProjectRef } from './types.js';
import type { ProviderIssue } from './provider-types.js';
import { projectBacklogLabels, type ScopedBacklogIdentityPolicy } from '../backlog/label-grammar.js';

/**
 * The inventory projection reads one issue's labels through the shared
 * grammar.  Its identity policy is `work-item`: the inventory spans every
 * project the credentials reach, so it publishes canonical work item ids
 * and an unqualified issue number names no single identity there.
 */
function identityOf(project: ProviderProjectRef): ScopedBacklogIdentityPolicy {
  return {
    kind: 'work-item',
    scope: { platform: project.platform, projectKey: project.projectKey },
  };
}

export function toGlobalWorkItem(project: ProviderProjectRef, issue: ProviderIssue): GlobalWorkItem {
  const id = formatWorkItemId({
    platform: project.platform,
    projectKey: project.projectKey,
    issueNumber: issue.issueNumber,
  });
  const projection = projectBacklogLabels(issue.labels, issue.state, identityOf(project));

  return {
    id,
    issueNumber: issue.issueNumber,
    project,
    title: issue.title,
    description: issue.description,
    managed: projection.managed,
    executionEligible: projection.executionEligible,
    state: projection.state,
    executionMode: projection.executionMode,
    parentId: projection.parentId,
    dependsOn: [...projection.dependsOn],
    tags: extractBacklogTags(issue.labels),
    branchName: deriveBacklogBranchName(String(issue.issueNumber)),
    providerRef: id,
    webUrl: issue.webUrl,
  };
}
