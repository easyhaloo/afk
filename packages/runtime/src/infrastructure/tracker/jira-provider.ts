import { z } from 'zod';
import { normalizeBaseUrl, requestJson, listLimit, type FetchLike } from './http.js';
import { IssueTrackerError, configurationError } from './issue-tracker-error.js';
import type { CreateIssueInput, IssueComment, IssueRelation, IssueRelationType, IssueTrackerIssue, IssueTrackerPort, ListIssuesOptions, UpdateIssueInput } from '../../plugin-sdk/issue-tracker.js';

export interface JiraTrackerOptions {
  readonly baseUrl: string;
  readonly projectKey: string;
  readonly token: string;
  readonly email?: string;
  readonly issueType?: string;
  readonly linkTypes?: { readonly blocks?: string; readonly duplicates?: string; readonly relatesTo?: string };
  readonly timeoutMs?: number;
  readonly fetch?: FetchLike;
}

interface AdfNode { type: string; text?: string; content?: AdfNode[] }
const adf: z.ZodType<AdfNode> = z.lazy(() => z.object({ type: z.string(), text: z.string().optional(), content: z.array(adf).optional() }));
const body = z.union([z.string(), adf, z.null()]);
const issue = z.object({
  id: z.string().min(1), key: z.string().min(1),
  fields: z.object({ summary: z.string(), description: body, labels: z.array(z.string()), status: z.object({ name: z.string() }) }),
});
const comment = z.object({
  id: z.string().min(1), body, author: z.object({ displayName: z.string() }).optional(), created: z.string().optional(), updated: z.string().optional(),
});
const linkedIssue = z.object({ key: z.string().min(1), id: z.string().optional() });
const link = z.object({
  id: z.string().min(1), type: z.object({ name: z.string() }),
  inwardIssue: linkedIssue.optional(), outwardIssue: linkedIssue.optional(),
}).refine(value => Boolean(value.inwardIssue) !== Boolean(value.outwardIssue));
const fields = ['summary', 'description', 'labels', 'status'];

export class JiraTrackerProvider implements IssueTrackerPort {
  readonly id = 'jira';
  readonly projectId: string;
  readonly baseUrl: string;
  private readonly fetcher: FetchLike;

  constructor(private readonly options: JiraTrackerOptions) {
    if (!options.token.trim()) throw configurationError('jira', 'constructor', 'token is required');
    if (!options.projectKey.trim()) throw configurationError('jira', 'constructor', 'projectKey is required');
    this.baseUrl = normalizeBaseUrl('jira', 'constructor', options.baseUrl);
    this.projectId = options.projectKey;
    this.fetcher = options.fetch ?? globalThis.fetch;
  }

  async getIssue(issueId: string): Promise<IssueTrackerIssue> {
    return this.mapIssue(await this.request('getIssue', `/rest/api/3/issue/${encodeURIComponent(issueId)}?fields=${fields.join(',')}`, issue));
  }

  async listIssues(options: ListIssuesOptions = {}): Promise<readonly IssueTrackerIssue[]> {
    const limit = listLimit(options.limit, this.id);
    const clauses = [`project = ${quoteJql(this.projectId)}`];
    if (options.state) clauses.push(`status = ${quoteJql(options.state)}`);
    for (const label of new Set(options.labels ?? [])) clauses.push(`labels = ${quoteJql(label)}`);
    const jql = `${clauses.join(' AND ')} ORDER BY updated DESC, key ASC`;
    const issues: IssueTrackerIssue[] = [];
    let nextPageToken = options.cursor;
    const seen = new Set<string>();
    if (nextPageToken) seen.add(nextPageToken);
    do {
      const result = await this.request('listIssues', '/rest/api/3/search/jql', z.object({
        issues: z.array(issue), isLast: z.boolean(), nextPageToken: z.string().optional(),
      }), { method: 'POST', body: JSON.stringify({ jql, fields, maxResults: Math.min(limit - issues.length, 100), nextPageToken }) });
      issues.push(...result.issues.slice(0, limit - issues.length).map(node => this.mapIssue(node)));
      if (result.isLast) break;
      if (!result.nextPageToken || seen.has(result.nextPageToken)) throw this.error('invalid-response', 'listIssues');
      nextPageToken = result.nextPageToken;
      seen.add(nextPageToken);
    } while (issues.length < limit);
    return issues;
  }

  async createIssue(input: CreateIssueInput): Promise<IssueTrackerIssue> {
    const result = await this.request('createIssue', '/rest/api/3/issue', linkedIssue, {
      method: 'POST', body: JSON.stringify({ fields: {
        project: { key: this.projectId }, summary: input.title,
        description: input.description === undefined ? undefined : toAdf(input.description),
        labels: input.labels, issuetype: { name: input.issueType ?? this.options.issueType ?? 'Task' },
      } }),
    }, [201]);
    return this.getIssue(result.key);
  }

  async updateIssue(issueId: string, input: UpdateIssueInput): Promise<IssueTrackerIssue> {
    const update: { summary?: string; description?: AdfNode; labels?: readonly string[] } = {};
    if (input.title !== undefined) update.summary = input.title;
    if (input.description !== undefined) update.description = toAdf(input.description);
    if (input.labels !== undefined) update.labels = input.labels;
    let transitionId: string | undefined;
    if (input.state !== undefined) {
      const result = await this.request('listTransitions', `/rest/api/3/issue/${encodeURIComponent(issueId)}/transitions`, z.object({
        transitions: z.array(z.object({ id: z.string().min(1), name: z.string(), to: z.object({ name: z.string() }) })),
      }));
      const matches = result.transitions.filter(candidate => candidate.to.name.toLowerCase() === input.state?.toLowerCase());
      if (matches.length !== 1) throw this.error('unsupported', 'transitionIssue');
      transitionId = matches[0].id;
    }
    if (Object.keys(update).length) await this.requestEmpty('updateIssue', `/rest/api/3/issue/${encodeURIComponent(issueId)}`, { method: 'PUT', body: JSON.stringify({ fields: update }) }, [204]);
    if (transitionId) await this.requestEmpty('transitionIssue', `/rest/api/3/issue/${encodeURIComponent(issueId)}/transitions`, { method: 'POST', body: JSON.stringify({ transition: { id: transitionId } }) }, [204]);
    return this.getIssue(issueId);
  }

  async deleteIssue(issueId: string): Promise<void> {
    await this.requestEmpty('deleteIssue', `/rest/api/3/issue/${encodeURIComponent(issueId)}`, { method: 'DELETE' }, [204]);
  }

  async addComment(issueId: string, value: string): Promise<IssueComment> {
    const result = await this.request('addComment', `/rest/api/3/issue/${encodeURIComponent(issueId)}/comment`, comment, { method: 'POST', body: JSON.stringify({ body: toAdf(value) }) }, [201]);
    return this.mapComment(issueId, result);
  }

  async listComments(issueId: string): Promise<readonly IssueComment[]> {
    const comments: IssueComment[] = [];
    let startAt = 0;
    do {
      const result = await this.request('listComments', `/rest/api/3/issue/${encodeURIComponent(issueId)}/comment?startAt=${startAt}&maxResults=100`, z.object({
        comments: z.array(comment), startAt: z.number().int().nonnegative(), total: z.number().int().nonnegative(),
      }));
      if (result.startAt !== startAt) throw this.error('invalid-response', 'listComments');
      comments.push(...result.comments.map(node => this.mapComment(issueId, node)));
      startAt += result.comments.length;
      if (startAt >= result.total) break;
      if (!result.comments.length) throw this.error('invalid-response', 'listComments');
    } while (true);
    return comments;
  }

  async updateComment(issueId: string, commentId: string, value: string): Promise<IssueComment> {
    const result = await this.request('updateComment', `/rest/api/3/issue/${encodeURIComponent(issueId)}/comment/${encodeURIComponent(commentId)}`, comment, { method: 'PUT', body: JSON.stringify({ body: toAdf(value) }) });
    return this.mapComment(issueId, result);
  }

  async deleteComment(issueId: string, commentId: string): Promise<void> {
    await this.requestEmpty('deleteComment', `/rest/api/3/issue/${encodeURIComponent(issueId)}/comment/${encodeURIComponent(commentId)}`, { method: 'DELETE' }, [204]);
  }

  async linkIssues(sourceIssueId: string, targetIssueId: string, type: IssueRelationType): Promise<IssueRelation> {
    const reversed = type === 'blocked-by';
    await this.requestEmpty('linkIssues', '/rest/api/3/issueLink', { method: 'POST', body: JSON.stringify({
      type: { name: this.linkTypeName(type) },
      inwardIssue: issueReference(reversed ? targetIssueId : sourceIssueId),
      outwardIssue: issueReference(reversed ? sourceIssueId : targetIssueId),
    }) }, [201]);
    const result = await this.readLinks(sourceIssueId);
    const match = result.fields.issuelinks.find(node => {
      const target = reversed ? node.inwardIssue : node.outwardIssue;
      return node.type.name === this.linkTypeName(type) && target && (target.key === targetIssueId || target.id === targetIssueId);
    });
    if (!match) throw this.error('invalid-response', 'linkIssues');
    const target = (reversed ? match.inwardIssue : match.outwardIssue)!;
    return { id: match.id, sourceIssueId: result.key, targetIssueId: target.key, type };
  }

  async listIssueLinks(issueId: string): Promise<readonly IssueRelation[]> {
    const result = await this.readLinks(issueId);
    return result.fields.issuelinks.map(node => {
      const inverse = Boolean(node.inwardIssue);
      const target = (node.inwardIssue ?? node.outwardIssue)!;
      let type: IssueRelationType;
      if (node.type.name === this.linkTypeName('blocks')) type = inverse ? 'blocked-by' : 'blocks';
      else if (node.type.name === this.linkTypeName('duplicates')) type = 'duplicates';
      else if (node.type.name === this.linkTypeName('relates-to')) type = 'relates-to';
      else throw this.error('unsupported', 'listIssueLinks');
      if (type === 'duplicates' && inverse) return { id: node.id, sourceIssueId: target.key, targetIssueId: result.key, type };
      return { id: node.id, sourceIssueId: result.key, targetIssueId: target.key, type };
    });
  }

  async health() {
    try {
      await this.request('health', '/rest/api/3/myself', z.object({ accountId: z.string().min(1) }));
      return { status: 'ok' as const };
    } catch (error) {
      return { status: 'unavailable' as const, message: error instanceof IssueTrackerError ? error.message : 'Jira health check failed' };
    }
  }

  async doctor() {
    const result = await this.health();
    return [{ check: 'credentials', ok: result.status === 'ok', detail: result.message }];
  }

  private readLinks(issueId: string) {
    return this.request('listIssueLinks', `/rest/api/3/issue/${encodeURIComponent(issueId)}?fields=issuelinks`, z.object({ key: z.string().min(1), fields: z.object({ issuelinks: z.array(link) }) }));
  }

  private linkTypeName(type: IssueRelationType): string {
    if (type === 'relates-to') return this.options.linkTypes?.relatesTo ?? 'Relates';
    if (type === 'duplicates') return this.options.linkTypes?.duplicates ?? 'Duplicate';
    return this.options.linkTypes?.blocks ?? 'Blocks';
  }

  private request<T>(operation: string, path: string, schema: z.ZodType<T>, init: RequestInit = {}, statuses: readonly number[] = [200]): Promise<T> {
    return requestJson({ ...this.requestOptions(operation, path, init), schema, statuses });
  }

  private requestEmpty(operation: string, path: string, init: RequestInit, statuses: readonly number[]): Promise<void> {
    return requestJson({ ...this.requestOptions(operation, path, init), allowEmpty: true, statuses });
  }

  private requestOptions(operation: string, path: string, init: RequestInit) {
    const authorization = this.options.email ? `Basic ${Buffer.from(`${this.options.email}:${this.options.token}`).toString('base64')}` : `Bearer ${this.options.token}`;
    return {
      provider: this.id, operation, fetch: this.fetcher, url: new URL(`${this.baseUrl}${path}`), timeoutMs: this.options.timeoutMs,
      init: { ...init, headers: { accept: 'application/json', 'content-type': 'application/json', authorization } },
    };
  }

  private mapIssue(node: z.infer<typeof issue>): IssueTrackerIssue {
    return { id: node.key, key: node.key, projectId: this.projectId, title: node.fields.summary, description: fromAdf(node.fields.description), state: node.fields.status.name, labels: node.fields.labels, url: `${this.baseUrl}/browse/${encodeURIComponent(node.key)}` };
  }

  private mapComment(issueId: string, node: z.infer<typeof comment>): IssueComment {
    return { id: node.id, issueId, body: fromAdf(node.body), author: node.author?.displayName, createdAt: node.created, updatedAt: node.updated };
  }

  private error(code: 'unsupported' | 'invalid-response', operation: string): IssueTrackerError {
    return new IssueTrackerError(code, `Jira ${operation} failed (${code})`, { provider: this.id, operation });
  }
}

function quoteJql(value: string): string {
  if (/[\u0000-\u001f\u007f]/.test(value)) throw configurationError('jira', 'listIssues', 'JQL values must not contain control characters');
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

function issueReference(value: string): { id: string } | { key: string } {
  return /^\d+$/.test(value) ? { id: value } : { key: value };
}

function toAdf(value: string) {
  return { type: 'doc', version: 1, content: value.split(/\r\n|\r|\n/).map(text => ({ type: 'paragraph', content: text ? [{ type: 'text', text }] : [] })) };
}

function fromAdf(value: string | AdfNode | null): string {
  if (typeof value === 'string') return value;
  if (!value) return '';
  if (value.type === 'text') return value.text ?? '';
  if (value.type === 'hardBreak') return '\n';
  const separator = ['doc', 'bulletList', 'orderedList', 'listItem', 'blockquote'].includes(value.type) ? '\n' : '';
  return (value.content ?? []).map(fromAdf).join(separator);
}
