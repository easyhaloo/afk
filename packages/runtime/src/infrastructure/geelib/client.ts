import { createHash } from 'node:crypto';
import { extractAC } from '../../domain/tracker/ac.js';
import type { AcceptanceCriteria } from '../../domain/tracker/ac-types.js';
import type {
  Branch,
  Commit,
  CreateIssueOptions,
  CreateMROptions,
  LabelDelta,
  ListOptions,
  MergeMROptions,
  Tag,
  TrackerIssueComment,
  TrackerProvider,
  TrackedIssue,
  TrackedMR,
  UploadArtifactsOptions,
  UploadedArtifact,
} from '../../domain/tracker/types.js';

/** A refused capability: every call rejects with the same clear diagnosis. */
type Refused = (...arguments_: never[]) => Promise<never>;

/** An untyped JSON object, narrowed from `unknown`. */
type UnknownObject = { [key: string]: unknown };

/**
 * The canonical query string the Geelib OpenAPI signs.
 *
 * Parameters flatten in ascending key order (`key[sub]` for objects,
 * `key[i]` for arrays) and encode RFC1738, so the same string works as the
 * GET query and as the signature input. This mirrors the platform's
 * published algorithm, verified against the geelib-cli reference client.
 */
export function geelibCanonical(params: UnknownObject): string {
  const pairs: string[] = [];
  const flatten = (prefix: string, value: unknown): void => {
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      for (const key of Object.keys(value).sort()) {
        flatten(prefix ? `${prefix}[${key}]` : key, (value as UnknownObject)[key]);
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((entry, index) => flatten(prefix ? `${prefix}[${index}]` : String(index), entry));
      return;
    }
    pairs.push(`${encode(prefix)}=${encode(String(value))}`);
  };
  flatten('', params);
  return pairs.join('&');
}

/** `sign = md5(md5(canonical) + token)` per the platform's OpenAPI docs. */
export function geelibSign(canonical: string, token: string): string {
  const inner = createHash('md5').update(canonical).digest('hex');
  return createHash('md5').update(inner + token).digest('hex');
}

/** RFC1738: space becomes `+` and `~` is percent-encoded. */
function encode(value: string): string {
  return encodeURIComponent(value)
    .replace(/%20/g, '+')
    .replace(/[!'()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/~/g, '%7E');
}

export interface GeelibClientOptions {
  /** The OpenAPI base, for example `https://geelib.qihoo.net`. */
  baseUrl: string;
  /** The account the requests authenticate as. */
  userMail: string;
  token: string;
  /** The numeric Geelib project (sub_id) this client is scoped to. */
  subId: number;
  /** Overridable for tests; defaults to the global fetch. */
  fetch?: typeof fetch;
}

interface MatterRecord {
  id: number;
  sub_id: number;
  type_id?: number;
  /** The type name, when the platform's payload carries one (e.g. 需求). */
  type_name?: unknown;
  title?: string;
  mkd_content?: string;
  matter_status?: number;
  label_name?: string;
  update_time?: string;
}

interface MatterStatus {
  id: number;
  status_name: string;
  status_stage: string;
}

interface GeelibEnvelope {
  errno: number;
  errmsg: string;
  data: unknown;
}

/**
 * The read-side Geelib tracker client.
 *
 * The platform's OpenAPI authenticates with a signed query (account, a
 * short-lived timestamp and a double digest) rather than a bearer token, so
 * the client signs every call itself. This slice carries the read-only
 * surface Phase 1 needs — listing and reading work items with their labels
 * and native states. Every capability outside that surface refuses with a
 * clear error instead of pretending; the write slice will replace those
 * refusals one by one.
 */
export class GeelibClient implements TrackerProvider {
  readonly platform = 'geelib' as const;
  readonly projectId: string | number;
  readonly providerHost: string;

  private readonly baseUrl: string;
  private readonly userMail: string;
  private readonly token: string;
  private readonly subId: number;
  private readonly doFetch: typeof fetch;
  private readonly statusCache = new Map<string, Promise<Map<number, MatterStatus>>>();

  constructor(options: GeelibClientOptions) {
    if (!options.token?.trim()) throw new Error('Geelib authentication requires a token');
    if (!options.userMail?.trim()) throw new Error('Geelib authentication requires the account mail');
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.userMail = options.userMail;
    this.token = options.token;
    this.subId = options.subId;
    this.projectId = String(options.subId);
    this.providerHost = new URL(this.baseUrl).host;
    this.doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  /** Another project on the same instance, for cross-project relationships. */
  forProject(projectKey: string): TrackerProvider {
    const subId = Number(projectKey);
    if (!Number.isSafeInteger(subId) || subId <= 0) throw new Error(`geelib project key must be the numeric project id: ${projectKey}`);
    return new GeelibClient({ ...this.options(), subId });
  }

  async getIssue(id: number): Promise<TrackedIssue> {
    const matters = await this.listMatters({ matterIds: [id] });
    const matter = matters.find(entry => entry.id === id);
    if (!matter) throw new Error(`geelib work item ${id} does not exist in project ${this.subId}`);
    return this.toTrackedIssue(matter);
  }

  /** The native status name of one work item, resolved through the status table. */
  async getMatterStateName(matterId: number): Promise<string | undefined> {
    return (await this.getMatterState(matterId)).name;
  }

  /**
   * The native status name **and** the generic stage of one work item.
   *
   * The stage (未开始/进行中/已完成/已关闭) is the platform's one status
   * dimension that is consistent across types and projects, while the names
   * are customized per type — the provider needs both.
   */
  async getMatterState(matterId: number): Promise<{ name: string | undefined; stage: string | undefined }> {
    const [matter] = await this.listMatters({ matterIds: [matterId] });
    if (!matter) throw new Error(`geelib work item ${matterId} does not exist in project ${this.subId}`);
    const typeId = Number(matter.type_id ?? 0);
    if (!typeId) return { name: undefined, stage: undefined };
    try {
      const table = await this.statusTable(matter.sub_id ?? this.subId, typeId);
      const entry = table.get(Number(matter.matter_status));
      return { name: entry?.status_name, stage: entry?.status_stage };
    } catch {
      return { name: undefined, stage: undefined };
    }
  }

  /** The native status names the work item's type defines (write gate). */
  async getMatterNativeStates(matterId: number): Promise<string[]> {
    const [matter] = await this.listMatters({ matterIds: [matterId] });
    if (!matter) throw new Error(`geelib work item ${matterId} does not exist in project ${this.subId}`);
    const typeId = Number(matter.type_id ?? 0);
    if (!typeId) return [];
    const table = await this.statusTable(matter.sub_id ?? this.subId, typeId);
    return [...table.values()].map(entry => entry.status_name);
  }

  /** The tag names provisioned on the project (the claim pre-flight checks these). */
  async listProjectTags(): Promise<string[]> {
    const envelope = await this.request('OpenApiCreateTagAndModule/getSubTags', { sub_id: this.subId });
    const data = envelope.data as { list?: Array<{ name?: string }> } | null;
    const list = Array.isArray(data?.list) ? data.list : [];
    return list.map(tag => String(tag.name ?? ''));
  }

  /**
   * The type identity of one work item, as the state-mapping resolver keys
   * its lookups: the numeric project (`sub_id`), the type id, and the type
   * name when the platform's payload carries one. The name is the stable
   * identifier the configuration documents; the id is the form every
   * payload carries.
   */
  async getMatterType(matterId: number): Promise<{ subId: number; typeId: number; typeName: string | undefined }> {
    const [matter] = await this.listMatters({ matterIds: [matterId] });
    if (!matter) throw new Error(`geelib work item ${matterId} does not exist in project ${this.subId}`);
    const typeName = typeof matter.type_name === 'string' && matter.type_name.trim() !== '' ? matter.type_name.trim() : undefined;
    return {
      subId: Number(matter.sub_id ?? this.subId),
      typeId: Number(matter.type_id ?? 0),
      typeName,
    };
  }

  async listIssues(options?: ListOptions): Promise<TrackedIssue[]> {
    const matters = await this.listAllMatters();
    let issues = await Promise.all(matters.map(matter => this.toTrackedIssue(matter)));
    const label = options?.labels?.find(Boolean);
    if (label) issues = issues.filter(issue => issue.labels.includes(label));
    return issues;
  }

  /** The projects the authenticated account can reach, for the global inventory. */
  async listCatalogProjects(): Promise<Array<{ id: number; name: string; updatedAt?: string }>> {
    const envelope = await this.request('OpenApiSubBusMgr/getSubBusList', {});
    const data = envelope.data as { list?: Array<{ id?: number; name?: string; update_time?: string }> } | null;
    const list = Array.isArray(data?.list) ? data.list : [];
    return list.map(project => ({
      id: Number(project.id),
      name: String(project.name ?? ''),
      ...(project.update_time ? { updatedAt: project.update_time } : {}),
    }));
  }

  /**
   * The work items of one project in the shape the global inventory stores.
   * Runs against any project on the instance, not only the one this client
   * was scoped to, so one catalog serves every discovered project.
   */
  async listCatalogIssues(subId: number): Promise<Array<{
    issueNumber: number;
    title: string;
    description: string;
    labels: string[];
    state: 'opened' | 'closed';
    updatedAt?: string;
    webUrl: string;
  }>> {
    const matters = await this.listAllMatters(subId);
    return Promise.all(matters.map(async matter => ({
      issueNumber: matter.id,
      title: String(matter.title ?? ''),
      description: String(matter.mkd_content ?? ''),
      labels: String(matter.label_name ?? '').split(',').map(name => name.trim()).filter(Boolean),
      state: await this.stateOf(matter, subId) === 'closed' ? 'closed' as const : 'opened' as const,
      ...(matter.update_time ? { updatedAt: matter.update_time } : {}),
      webUrl: `${this.baseUrl}/geelib/project/matter/detail?subId=${matter.sub_id ?? subId}&id=${matter.id}`,
    })));
  }

  /**
   * The account behind this client's credentials. The platform exposes no
   * "who am I" call, so the identity resolves by searching the configured
   * mail and matching it exactly; a miss means the credentials cannot be
   * verified and the resolver reports that per catalog.
   */
  async accountIdentity(): Promise<{ accountId: string }> {
    const envelope = await this.request('UserMgr/getUserListBySearch', { query: this.userMail });
    const data = envelope.data as { list?: Array<{ id?: number; mail?: string }> } | null;
    const list = Array.isArray(data?.list) ? data.list : [];
    const match = list.find(user => String(user.mail ?? '').toLowerCase() === this.userMail.toLowerCase());
    if (!match) throw new Error(`geelib account ${this.userMail} could not be verified against the instance`);
    return { accountId: String(match.id) };
  }

  /** `parseAC` matches the git providers: the body carries the acceptance criteria. */
  parseAC(issue: Pick<TrackedIssue, 'labels' | 'description'>): AcceptanceCriteria {
    return extractAC(issue);
  }

  /**
   * Move a work item to a native status through the edit call.
   *
   * The platform customizes status names per type and project, so the
   * caller — the backlog provider's gate, which vets the target against the
   * item type's own vocabulary (`getMatterNativeStates`) — owns the name
   * check; this method only refuses an empty one. A configured mapping
   * therefore drives names far beyond the 缺陷 workflow's verified set.
   */
  async setStatus(matterId: number, state: string): Promise<void> {
    const name = String(state).trim();
    if (!name) {
      throw new Error('setStatus requires a non-empty native state name; resolve it through the state mapping first');
    }
    await this.request('Matter/edit', {
      sub_id: this.subId,
      id: matterId,
      data: [{ cf_name: '状态', cf_value: name }],
    }, { method: 'POST' });
  }

  /** Append one comment. The platform requires HTML rich text. */
  async addComment(matterId: number, html: string): Promise<void> {
    await this.request('OpenApiCommentMgr/addComment', {
      sub_id: this.subId,
      id: matterId,
      type: 'matter',
      content: html,
    }, { method: 'POST' });
  }

  /** The comments of a work item, read from the requested silo. */
  async listComments(matterId: number, commentType: 'bug' | 'matter' | 'demand'): Promise<Array<{ id: string; body: string; author: string; time: string }>> {
    const envelope = await this.request('OpenApiCommentMgr/getList', {
      sub_id: this.subId,
      type: commentType,
      id: matterId,
    });
    const comments = Array.isArray(envelope.data) ? envelope.data as Array<{ id?: string; content?: string; create_by_name?: string; create_time?: string }> : [];
    return comments.map(comment => ({
      id: String(comment.id ?? ''),
      body: String(comment.content ?? ''),
      author: String(comment.create_by_name ?? ''),
      time: String(comment.create_time ?? ''),
    }));
  }

  /** TrackerProvider surface: the comment silo AFK writes to (`matter`). */
  async listIssueComments(id: number): Promise<TrackerIssueComment[]> {
    const comments = await this.listComments(id, 'matter');
    return comments.map(comment => ({ id: comment.id, body: comment.body }));
  }

  /**
   * Replace the whole label set — the platform's labels are one overwrite
   * field, written as a JSON array of names. Every name must already exist
   * on the project: a name the project does not have is silently dropped
   * (errno 2000), so callers verify the read-back after writing.
   */
  async setLabels(matterId: number, labels: readonly string[]): Promise<void> {
    await this.request('Matter/edit', {
      sub_id: this.subId,
      id: matterId,
      data: [{ cf_name: '标签', cf_value: JSON.stringify(labels) }],
    }, { method: 'POST' });
  }

  /**
   * Point a work item at its native parent. The parent edge is the one the
   * platform UI shows as the hierarchy; dependencies ride on the
   * resource-reference module instead.
   */
  async changeParent(matterId: number, parentId: number): Promise<void> {
    await this.request('Matter/changeParent', {
      sub_id: this.subId,
      id: matterId,
      parent_id: parentId,
    }, { method: 'POST' });
  }

  /**
   * Reference other work items as dependencies of this one.
   *
   * The reference module is the platform's only cross-project link between
   * work items, so it carries the AFK dependency edges. The target's title
   * is part of the payload the platform requires — callers read it first.
   *
   * The `data` group travels as one JSON **string**: the server signs it as
   * a single parameter, and the nested-object form fails the signature
   * check (errno 4001, verified live against the reference signer).
   */
  async addResourceReferences(matterId: number, targets: ReadonlyArray<{ id: number; title: string; subId: number }>): Promise<void> {
    await this.request('OpenApiResourcesMgr/addResources', {
      id: matterId,
      source: 'matter',
      data: JSON.stringify({ matter: targets.map(target => ({ id: target.id, title: target.title, sub_id: target.subId })) }),
    }, { method: 'POST' });
  }

  /**
   * The work items this one references, decoded from the module's list.
   *
   * Each entry's `id` is the platform's reference record; the referenced
   * work item is `type_id` (verified live). `referenceId` is kept for
   * diagnostics only — the platform's own deletion call refuses every id
   * form probed (its CLI fails identically), so removal is not implemented.
   */
  async listResourceReferences(matterId: number): Promise<Array<{ referenceId: number; id: number; title: string; subId: number }>> {
    const envelope = await this.request('OpenApiResourcesMgr/getDemandReourcesList', { id: matterId, source: 'matter' });
    const data = envelope.data as { matter?: Array<{ id?: number; type_id?: number; title?: string; sub_id?: string | number }> } | null;
    const references = Array.isArray(data?.matter) ? data.matter : [];
    return references
      .filter(reference => reference.type_id !== undefined)
      .map(reference => ({
        referenceId: Number(reference.id),
        id: Number(reference.type_id),
        title: String(reference.title ?? ''),
        subId: Number(reference.sub_id ?? this.subId),
      }));
  }

  /**
   * Unimplemented: the platform's deletion endpoint reports 项目资源不存在
   * for every id form probed — including through the platform's own
   * geelib-cli. Removal happens on the platform UI; this gap is a platform
   * confirmation item.
   */
  async removeResourceReference(): Promise<never> {
    throw new Error('The geelib provider cannot delete resource references: the platform deletion API refuses every id form (its own CLI fails identically); remove them on the platform UI.');
  }

  getRetryCount(): number {
    // Geelib carries no retry-count channel; retries are tracked in AFK's own records.
    return 0;
  }

  private options(): GeelibClientOptions {
    return { baseUrl: this.baseUrl, userMail: this.userMail, token: this.token, subId: this.subId, fetch: this.doFetch };
  }

  private async listMatters(filters: { subId?: number; matterIds?: number[] } = {}): Promise<MatterRecord[]> {
    const subId = filters.subId ?? this.subId;
    const envelope = await this.request('Matter/getList', {
      sub_id: subId,
      page: 1,
      pageSize: filters.matterIds?.length ?? 20,
      simple: 0,
      ...(filters.matterIds ? { matter_ids: filters.matterIds } : {}),
    });
    const data = envelope.data as { total?: number; matterList?: MatterRecord[] } | null;
    return Array.isArray(data?.matterList) ? data.matterList : [];
  }

  private async listAllMatters(subId = this.subId): Promise<MatterRecord[]> {
    const all: MatterRecord[] = [];
    const pageSize = 100;
    for (let page = 1; page <= 200; page += 1) {
      const envelope = await this.request('Matter/getList', { sub_id: subId, page, pageSize, simple: 0 });
      const data = envelope.data as { total?: number; matterList?: MatterRecord[] } | null;
      const matters = Array.isArray(data?.matterList) ? data.matterList : [];
      all.push(...matters);
      if (matters.length < pageSize || all.length >= (data?.total ?? 0)) break;
    }
    return all;
  }

  private async toTrackedIssue(matter: MatterRecord): Promise<TrackedIssue> {
    return {
      id: matter.id,
      platform: 'geelib',
      title: String(matter.title ?? ''),
      description: String(matter.mkd_content ?? ''),
      labels: String(matter.label_name ?? '').split(',').map(name => name.trim()).filter(Boolean),
      state: await this.stateOf(matter),
      url: `${this.baseUrl}/geelib/project/matter/detail?subId=${matter.sub_id ?? this.subId}&id=${matter.id}`,
      projectId: String(matter.sub_id ?? this.subId),
    };
  }

  /**
   * The native state decides open versus closed: any state in the platform's
   * `已完成` stage counts as closed, everything else is open. The status
   * table is read once per work-item type and cached on the client.
   */
  private async stateOf(matter: MatterRecord, subId = this.subId): Promise<TrackedIssue['state']> {
    const typeId = Number(matter.type_id ?? 0);
    if (!typeId) return 'opened';
    try {
      const statuses = await this.statusTable(subId, typeId);
      return statuses.get(Number(matter.matter_status))?.status_stage === '已完成' ? 'closed' : 'opened';
    } catch {
      return 'opened';
    }
  }

  private statusTable(subId: number, typeId: number): Promise<Map<number, MatterStatus>> {
    const cacheKey = `${subId}:${typeId}`;
    let table = this.statusCache.get(cacheKey);
    if (!table) {
      table = this.request('Matter/getMatterStatus', { sub_id: subId, type_id: String(typeId) })
        .then(envelope => {
          const statuses = Array.isArray(envelope.data) ? envelope.data as MatterStatus[] : [];
          return new Map(statuses.map(status => [Number(status.id), status]));
        });
      table.catch(() => this.statusCache.delete(cacheKey));
      this.statusCache.set(cacheKey, table);
    }
    return table;
  }

  private async request(path: string, params: UnknownObject, options: { method?: 'GET' | 'POST' } = {}): Promise<GeelibEnvelope> {
    const method = options.method ?? 'GET';
    const signed = { ...params, t: Math.floor(Date.now() / 1000), user_mail: this.userMail };
    const sign = geelibSign(geelibCanonical(signed), this.token);
    const url = `${this.baseUrl}/openapi/${path}`;
    const response = method === 'POST'
      ? await this.doFetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'From-App': this.userMail },
          body: JSON.stringify({ ...signed, sign }),
        })
      : await this.doFetch(`${url}?${geelibCanonical({ ...signed, sign })}`, { headers: { 'From-App': this.userMail } });
    const envelope = await response.json() as GeelibEnvelope;
    if (envelope.errno !== 2000) throw new Error(`geelib ${path} failed: ${envelope.errmsg || `errno ${envelope.errno}`}`);
    return envelope;
  }

  // ── Refused capabilities ────────────────────────────────────────────────
  //
  // This slice carries the read-only surface Phase 1 needs. Every capability
  // outside it refuses with the same clear diagnosis, so a caller that
  // reaches one learns what happened instead of watching the wrong provider
  // handle the call. The write slice replaces these one by one.

  private refused(operation: string): Refused {
    return async () => {
      throw new Error(`The geelib provider does not support ${operation} yet; it lands in a later slice.`);
    };
  }

  createIssue = this.refused('creating work items');
  updateIssue = this.refused('editing work items');
  updateLabels = this.refused('editing labels');
  addLabel = this.refused('editing labels');
  removeLabel = this.refused('editing labels');
  updateIssueComment = this.refused('editing comments');

  linkIssues = this.refused('linking work items');
  getMR = this.refused('change requests');
  isMRLinkedToIssue = this.refused('change requests');
  listMRs = this.refused('change requests');
  createMR = this.refused('change requests');
  mergeMR = this.refused('merging change requests');
  updateMR = this.refused('change requests');
  approveMR = this.refused('approving change requests');
  closeMR = this.refused('change requests');
  reopenMR = this.refused('change requests');
  listProjects = this.refused('listing projects');
  getBranches = this.refused('code hosting');
  getTags = this.refused('code hosting');
  getRecentCommits = this.refused('code hosting');
  uploadArtifacts = this.refused('uploading artifacts');
}
