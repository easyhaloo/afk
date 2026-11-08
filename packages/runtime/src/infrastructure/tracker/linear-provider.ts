import { z } from 'zod';
import type {
  CreateIssueInput, IssueComment, IssueRelation, IssueRelationType, IssueTrackerIssue,
  IssueTrackerPort, ListIssuesOptions, UpdateIssueInput,
} from '../../plugin-sdk/issue-tracker.js';
import { requestJson, normalizeBaseUrl, listLimit, type FetchLike } from './http.js';
import { IssueTrackerError, configurationError } from './issue-tracker-error.js';

export interface LinearTrackerOptions {
  readonly baseUrl: string;
  readonly token: string;
  readonly teamId: string;
  readonly timeoutMs?: number;
  readonly fetch?: FetchLike;
}

type GraphqlVariable = string | number | boolean | null | undefined | readonly GraphqlVariable[] | { readonly [key: string]: GraphqlVariable };

const identity = z.object({ id: z.string().min(1) });
const pageInfo = z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() });
const connection = <Schema extends z.ZodTypeAny>(node: Schema) => z.object({ nodes: z.array(node), pageInfo });
const label = z.object({ id: z.string(), name: z.string(), team: identity.nullable() });
const issue = z.object({
  id: z.string().min(1), identifier: z.string().min(1), title: z.string(), description: z.string().nullable(),
  team: identity, state: z.object({ name: z.string() }),
  labels: connection(z.object({ name: z.string() })), url: z.string(),
});
const comment = z.object({
  id: z.string().min(1), body: z.string(), user: z.object({ name: z.string() }).nullable(),
  createdAt: z.string(), updatedAt: z.string(),
});
const relation = z.object({
  id: z.string().min(1), type: z.enum(['blocks', 'duplicate', 'related', 'similar']),
  issue: identity, relatedIssue: identity,
});
const issueFields = 'id identifier title description url team { id } state { name } labels(first: 100) { nodes { name } pageInfo { hasNextPage endCursor } }';
const commentFields = 'id body createdAt updatedAt user { name }';
const relationFields = 'id type issue { id } relatedIssue { id }';

export class LinearTrackerProvider implements IssueTrackerPort {
  readonly id = 'linear';
  readonly projectId: string;
  readonly baseUrl: string;
  private readonly fetcher: FetchLike;

  constructor(private readonly options: LinearTrackerOptions) {
    if (!options.token.trim()) throw configurationError('linear', 'constructor', 'token is required');
    if (!options.teamId.trim()) throw configurationError('linear', 'constructor', 'teamId is required');
    this.baseUrl = normalizeBaseUrl('linear', 'constructor', options.baseUrl);
    this.projectId = options.teamId;
    this.fetcher = options.fetch ?? globalThis.fetch;
  }

  async getIssue(issueId: string): Promise<IssueTrackerIssue> {
    const result = await this.graphql('getIssue', `query GetIssue($id: String!) { issue(id: $id) { ${issueFields} } }`, { id: issueId }, z.object({ issue: issue.nullable() }));
    if (!result.issue) throw this.error('not-found', 'getIssue');
    return this.mapIssue(result.issue);
  }

  async listIssues(options: ListIssuesOptions = {}): Promise<readonly IssueTrackerIssue[]> {
    const limit = listLimit(options.limit, this.id);
    const filter = {
      team: { id: { eq: this.projectId } },
      ...(options.state ? { state: { name: { eqIgnoreCase: options.state } } } : {}),
      ...(options.labels?.length ? { and: [...new Set(options.labels)].map(name => ({ labels: { some: { name: { eq: name } } } })) } : {}),
    };
    const issues: IssueTrackerIssue[] = [];
    let after = options.cursor ?? null;
    const seen = new Set<string>();
    if (after) seen.add(after);
    do {
      const result = await this.graphql('listIssues', `query ListIssues($filter: IssueFilter!, $first: Int!, $after: String) { issues(filter: $filter, first: $first, after: $after) { nodes { ${issueFields} } pageInfo { hasNextPage endCursor } } }`, { filter, first: Math.min(limit - issues.length, 100), after }, z.object({ issues: connection(issue) }));
      for (const node of result.issues.nodes.slice(0, limit - issues.length)) issues.push(await this.mapIssue(node));
      after = this.nextCursor(result.issues.pageInfo, seen, 'listIssues');
    } while (after && issues.length < limit);
    return issues;
  }

  async createIssue(input: CreateIssueInput): Promise<IssueTrackerIssue> {
    if (input.issueType !== undefined) throw this.error('unsupported', 'createIssue');
    const labelIds = await this.resolveLabelIds(input.labels, this.projectId);
    const result = await this.graphql('createIssue', `mutation CreateIssue($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { ${issueFields} } } }`, {
      input: { teamId: this.projectId, title: input.title, description: input.description, labelIds },
    }, z.object({ issueCreate: z.object({ success: z.literal(true), issue }) }));
    return this.mapIssue(result.issueCreate.issue);
  }

  async updateIssue(issueId: string, input: UpdateIssueInput): Promise<IssueTrackerIssue> {
    const current = input.state !== undefined || input.labels !== undefined ? await this.getIssue(issueId) : undefined;
    const teamId = current?.projectId ?? this.projectId;
    const labelIds = await this.resolveLabelIds(input.labels, teamId);
    let stateId: string | undefined;
    if (input.state !== undefined) {
      const result = await this.graphql('resolveState', 'query ResolveState($filter: WorkflowStateFilter!) { workflowStates(filter: $filter, first: 2) { nodes { id } } }', {
        filter: { team: { id: { eq: teamId } }, name: { eqIgnoreCase: input.state } },
      }, z.object({ workflowStates: z.object({ nodes: z.array(identity) }) }));
      if (result.workflowStates.nodes.length !== 1) throw this.error('not-found', 'resolveState');
      stateId = result.workflowStates.nodes[0].id;
    }
    const result = await this.graphql('updateIssue', `mutation UpdateIssue($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success issue { ${issueFields} } } }`, {
      id: issueId, input: { title: input.title, description: input.description, labelIds, stateId },
    }, z.object({ issueUpdate: z.object({ success: z.literal(true), issue }) }));
    return this.mapIssue(result.issueUpdate.issue);
  }

  async deleteIssue(issueId: string): Promise<void> {
    await this.graphql('deleteIssue', 'mutation DeleteIssue($id: String!) { issueDelete(id: $id) { success } }', { id: issueId }, z.object({ issueDelete: z.object({ success: z.literal(true) }) }));
  }

  async addComment(issueId: string, body: string): Promise<IssueComment> {
    const result = await this.graphql('addComment', `mutation AddComment($input: CommentCreateInput!) { commentCreate(input: $input) { success comment { ${commentFields} } } }`, { input: { issueId, body } }, z.object({ commentCreate: z.object({ success: z.literal(true), comment }) }));
    return this.mapComment(issueId, result.commentCreate.comment);
  }

  async listComments(issueId: string): Promise<readonly IssueComment[]> {
    return this.collect('listComments', async after => {
      const result = await this.graphql('listComments', `query ListComments($id: String!, $after: String) { issue(id: $id) { comments(first: 100, after: $after) { nodes { ${commentFields} } pageInfo { hasNextPage endCursor } } } }`, { id: issueId, after }, z.object({ issue: z.object({ comments: connection(comment) }).nullable() }));
      if (!result.issue) throw this.error('not-found', 'listComments');
      return { ...result.issue.comments, nodes: result.issue.comments.nodes.map(node => this.mapComment(issueId, node)) };
    });
  }

  async updateComment(issueId: string, commentId: string, body: string): Promise<IssueComment> {
    await this.checkCommentOwner(issueId, commentId);
    const result = await this.graphql('updateComment', `mutation UpdateComment($id: String!, $input: CommentUpdateInput!) { commentUpdate(id: $id, input: $input) { success comment { ${commentFields} } } }`, { id: commentId, input: { body } }, z.object({ commentUpdate: z.object({ success: z.literal(true), comment }) }));
    return this.mapComment(issueId, result.commentUpdate.comment);
  }

  async deleteComment(issueId: string, commentId: string): Promise<void> {
    await this.checkCommentOwner(issueId, commentId);
    await this.graphql('deleteComment', 'mutation DeleteComment($id: String!) { commentDelete(id: $id) { success } }', { id: commentId }, z.object({ commentDelete: z.object({ success: z.literal(true) }) }));
  }

  async linkIssues(sourceIssueId: string, targetIssueId: string, type: IssueRelationType): Promise<IssueRelation> {
    const reversed = type === 'blocked-by';
    const result = await this.graphql('linkIssues', `mutation LinkIssues($input: IssueRelationCreateInput!) { issueRelationCreate(input: $input) { success issueRelation { ${relationFields} } } }`, {
      input: {
        issueId: reversed ? targetIssueId : sourceIssueId, relatedIssueId: reversed ? sourceIssueId : targetIssueId,
        type: type === 'relates-to' ? 'related' : type === 'duplicates' ? 'duplicate' : 'blocks',
      },
    }, z.object({ issueRelationCreate: z.object({ success: z.literal(true), issueRelation: relation }) }));
    const node = result.issueRelationCreate.issueRelation;
    return { id: node.id, sourceIssueId: reversed ? node.relatedIssue.id : node.issue.id, targetIssueId: reversed ? node.issue.id : node.relatedIssue.id, type };
  }

  async listIssueLinks(issueId: string): Promise<readonly IssueRelation[]> {
    const links: IssueRelation[] = [];
    for (const field of ['relations', 'inverseRelations'] as const) {
      const nodes = await this.collect('listIssueLinks', async after => {
        const schema = z.object({ issue: z.object({ [field]: connection(relation) }).nullable() });
        const result = await this.graphql('listIssueLinks', `query ListRelations($id: String!, $after: String) { issue(id: $id) { ${field}(first: 100, after: $after) { nodes { ${relationFields} } pageInfo { hasNextPage endCursor } } } }`, { id: issueId, after }, schema);
        if (!result.issue) throw this.error('not-found', 'listIssueLinks');
        return result.issue[field];
      });
      for (const node of nodes) {
        if (node.type === 'similar') throw this.error('unsupported', 'listIssueLinks');
        const inverse = field === 'inverseRelations' && node.type === 'blocks';
        links.push({ id: node.id, sourceIssueId: inverse ? node.relatedIssue.id : node.issue.id, targetIssueId: inverse ? node.issue.id : node.relatedIssue.id, type: inverse ? 'blocked-by' : node.type === 'related' ? 'relates-to' : node.type === 'duplicate' ? 'duplicates' : 'blocks' });
      }
    }
    return [...new Map(links.map(link => [link.id, link])).values()];
  }

  async health() {
    try {
      await this.graphql('health', 'query Health { viewer { id } }', {}, z.object({ viewer: identity }));
      return { status: 'ok' as const };
    } catch (error) {
      return { status: 'unavailable' as const, message: error instanceof IssueTrackerError ? error.message : 'Linear health check failed' };
    }
  }

  async doctor() {
    const result = await this.health();
    return [{ check: 'credentials', ok: result.status === 'ok', detail: result.message }];
  }

  private async checkCommentOwner(issueId: string, commentId: string): Promise<void> {
    const result = await this.graphql('commentOwner', 'query CommentOwner($id: String!) { comment(id: $id) { issue { id identifier } } }', { id: commentId }, z.object({ comment: z.object({ issue: z.object({ id: z.string(), identifier: z.string() }).nullable() }).nullable() }));
    const owner = result.comment?.issue;
    if (!owner || (owner.id !== issueId && owner.identifier !== issueId)) throw this.error('not-found', 'commentOwner');
  }

  private async resolveLabelIds(labels: readonly string[] | undefined, teamId: string): Promise<readonly string[] | undefined> {
    if (!labels?.length) return labels ? [] : undefined;
    const nodes = await this.collect('resolveLabels', async after => {
      const result = await this.graphql('resolveLabels', 'query ResolveLabels($filter: IssueLabelFilter!, $after: String) { issueLabels(filter: $filter, first: 100, after: $after) { nodes { id name team { id } } pageInfo { hasNextPage endCursor } } }', {
        filter: { name: { in: [...new Set(labels)] }, or: [{ team: { id: { eq: teamId } } }, { team: { null: true } }] }, after,
      }, z.object({ issueLabels: connection(label) }));
      return result.issueLabels;
    });
    return [...new Set(labels)].map(name => {
      const matches = nodes.filter(node => node.name === name);
      const local = matches.filter(node => node.team?.id === teamId);
      const candidates = local.length ? local : matches.filter(node => node.team === null);
      if (candidates.length !== 1) throw this.error('not-found', 'resolveLabels');
      return candidates[0].id;
    });
  }

  private async collect<T>(operation: string, load: (after: string | null) => Promise<{ nodes: T[]; pageInfo: z.infer<typeof pageInfo> }>): Promise<T[]> {
    const nodes: T[] = [];
    const seen = new Set<string>();
    let after: string | null = null;
    do {
      const page = await load(after);
      nodes.push(...page.nodes);
      after = this.nextCursor(page.pageInfo, seen, operation);
    } while (after);
    return nodes;
  }

  private nextCursor(page: z.infer<typeof pageInfo>, seen: Set<string>, operation: string): string | null {
    if (!page.hasNextPage) return null;
    if (!page.endCursor || seen.has(page.endCursor)) throw this.error('invalid-response', operation);
    seen.add(page.endCursor);
    return page.endCursor;
  }

  private async graphql<T>(operation: string, query: string, variables: { readonly [key: string]: GraphqlVariable }, schema: z.ZodType<T>): Promise<T> {
    const response = await requestJson({
      provider: this.id, operation, fetch: this.fetcher, url: new URL(this.baseUrl), timeoutMs: this.options.timeoutMs,
      statuses: [200], schema: { parse(value) { return schema.parse(z.object({ data: z.unknown() }).parse(value).data); } },
      init: { method: 'POST', headers: { authorization: this.options.token, 'content-type': 'application/json' }, body: JSON.stringify({ query, variables }) },
    });
    return response;
  }

  private async mapIssue(node: z.infer<typeof issue>): Promise<IssueTrackerIssue> {
    const labels = node.labels.nodes.map(value => value.name);
    const seen = new Set<string>();
    let after = this.nextCursor(node.labels.pageInfo, seen, 'issueLabels');
    while (after) {
      const result = await this.graphql('issueLabels', 'query IssueLabels($id: String!, $after: String) { issue(id: $id) { labels(first: 100, after: $after) { nodes { name } pageInfo { hasNextPage endCursor } } } }', { id: node.id, after }, z.object({ issue: z.object({ labels: connection(z.object({ name: z.string() })) }) }));
      labels.push(...result.issue.labels.nodes.map(value => value.name));
      after = this.nextCursor(result.issue.labels.pageInfo, seen, 'issueLabels');
    }
    return { id: node.id, key: node.identifier, projectId: node.team.id, title: node.title, description: node.description ?? '', state: node.state.name, labels, url: node.url };
  }

  private mapComment(issueId: string, node: z.infer<typeof comment>): IssueComment {
    return { id: node.id, issueId, body: node.body, author: node.user?.name, createdAt: node.createdAt, updatedAt: node.updatedAt };
  }

  private error(code: 'not-found' | 'invalid-response' | 'unsupported', operation: string): IssueTrackerError {
    return new IssueTrackerError(code, `Linear ${operation} failed (${code})`, { provider: this.id, operation });
  }
}
