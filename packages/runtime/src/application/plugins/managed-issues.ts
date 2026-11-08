import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { BacklogItem, BacklogProvider, BacklogState } from '../../domain/backlog/index.js';
import { parseCanonicalProject, parseWorkItemId } from '../../domain/work-item/identity.js';
import type { IssueTrackerPort } from '../../plugin-sdk/issue-tracker.js';
import { FilesystemClaimLock } from '../../domain/backlog/claim.js';

const externalState = z.string().trim().min(1).max(256).refine(value => !/[\r\n]/.test(value)).optional();
export const managedIssueStateMapSchema = z.object({ ready: externalState, rework: externalState, in_progress: externalState, verification: externalState, merge_ready: externalState, done: externalState, blocked: externalState }).strict();

function sourceIdentity(provider: IssueTrackerPort, issueId: string): string {
  const endpoint = new URL(provider.baseUrl);
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error('Tracker URL must not contain credentials or query parameters');
  if (!issueId.trim() || issueId.length > 256) throw new Error('Invalid source issue identity');
  return createHash('sha256').update(JSON.stringify([provider.id, endpoint.href, provider.projectId, issueId])).digest('hex');
}

function sourceMarker(identity: string): string {
  return `<!-- managed-issue-source:${identity} -->`;
}

function externalDescription(value: string): string {
  return value.replace(/<!--\s*(?:managed-issue-source|afk:idempotency):[\s\S]*?-->/g, '').trimEnd();
}

export async function importManagedIssue(input: {
  provider: IssueTrackerPort;
  issueId: string;
  project: string;
  backlog: Pick<BacklogProvider, 'create'>;
  executionMode?: 'afk' | 'hitl';
}): Promise<BacklogItem> {
  parseCanonicalProject(input.project);
  const issue = await input.provider.getIssue(input.issueId);
  if (issue.projectId !== input.provider.projectId) throw new Error('Source issue belongs to another tracker project');
  const identity = sourceIdentity(input.provider, issue.id);
  const item = await new FilesystemClaimLock().withExclusiveOperation(`external-issue/${input.project}/${identity}`, () => input.backlog.create({
    title: issue.title,
    description: `${externalDescription(issue.description)}\n\nExternal issue: ${externalDescription(issue.key)}\n\n${sourceMarker(identity)}`,
    executionMode: input.executionMode ?? 'hitl',
    idempotencyKey: `external-issue:${identity}`,
  }));
  const managed = parseWorkItemId(item.id);
  if (`${managed.platform}:${managed.projectKey}` !== input.project) throw new Error('Managed issue belongs to another repository');
  return item;
}

export async function syncManagedIssue(input: {
  provider: IssueTrackerPort;
  issueId: string;
  item: BacklogItem;
  states: Partial<Record<BacklogState, string>>;
}): Promise<{ issueId: string; workItemId: string; state: string; updated: boolean }> {
  const states = managedIssueStateMapSchema.parse(input.states);
  parseWorkItemId(input.item.id);
  const issue = await input.provider.getIssue(input.issueId);
  if (issue.projectId !== input.provider.projectId) throw new Error('Source issue belongs to another tracker project');
  const marker = sourceMarker(sourceIdentity(input.provider, issue.id));
  const bindings = (input.item.description ?? '').match(/<!--\s*managed-issue-source:[\s\S]*?-->/g) ?? [];
  if (bindings.length !== 1 || bindings[0] !== marker) throw new Error('Managed issue has no matching source binding');
  if (!input.item.state) throw new Error('Organizational parent has no lifecycle state to synchronize');
  const state = states[input.item.state];
  if (!state || !state.trim() || state.length > 256 || /[\r\n]/.test(state)) throw new Error(`No valid external state mapping for ${input.item.state}`);
  if (issue.state !== state) await input.provider.updateIssue(issue.id, { state });
  return { issueId: issue.key, workItemId: input.item.id, state, updated: issue.state !== state };
}
