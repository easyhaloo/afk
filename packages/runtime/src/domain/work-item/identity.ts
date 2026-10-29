import { isWorkItemProjectKey } from '@afk/core';

export const WORK_ITEM_PLATFORMS = ['github', 'gitlab'] as const;

export type WorkItemPlatform = typeof WORK_ITEM_PLATFORMS[number];

declare const workItemIdBrand: unique symbol;

export type WorkItemId = string & { readonly [workItemIdBrand]: 'WorkItemId' };

export interface WorkItemIdentityParts {
  platform: WorkItemPlatform;
  projectKey: string;
  issueNumber: number;
}

/**
 * The project a work item identity belongs to.
 *
 * A scope names a platform and a canonical project key. It is what resolves
 * a relationship reference that names no project: a bare issue number means
 * "the issue number in this project".
 */
export interface WorkItemScope {
  platform: WorkItemPlatform;
  projectKey: string;
}

/**
 * The canonical project key of a provider project.
 *
 * GitHub projects are `owner/repo`. GitLab projects carry the instance host
 * (`host/group/repo`) for every instance except the default one, so two
 * self-hosted instances never collapse into one identity while the ordinary
 * gitlab.com project keeps the key it always had.
 *
 * A first path segment that contains a dot is therefore read as a host. That
 * is the same rule the tracker adapter uses to route a relationship to
 * another project, so a key names one project in both places.
 *
 * This is the single rule for naming a project. The global inventory, the
 * tracker adapter and the run request resolver must all derive the key with
 * this function, otherwise the same issue gets two identities and its
 * execution workspace, runtime record and Desktop projection drift apart.
 */
export function canonicalProjectKey(platform: WorkItemPlatform, projectId: string, providerHost?: string): string {
  const path = projectId.trim().replace(/^\/+|\/+$/g, '');
  if (!path) throw new Error('provider project id must not be empty');
  if (platform === 'github') {
    const segments = path.split('/').filter(Boolean);
    if (segments.length !== 2) throw new Error('GitHub project key must use owner/repo');
    return segments.join('/');
  }
  const host = (providerHost ?? 'gitlab.com').trim().toLowerCase();
  const prefix = `${host}/`;
  const projectPath = path.toLowerCase().startsWith(prefix) ? path.slice(prefix.length) : path;
  if (!projectPath) throw new Error('GitLab project key must include a project path');
  return host === 'gitlab.com' ? projectPath : `${host}/${projectPath}`;
}

/** The host a GitLab project key names, when it names one at all. */
export function gitLabProjectHost(projectKey: string): string | undefined {
  const [first] = projectKey.split('/');
  return first && first.includes('.') ? first : undefined;
}

/** A canonical project key, read back into the parts a provider needs. */
export interface CanonicalProject {
  platform: WorkItemPlatform;
  /** The canonical project key. */
  projectKey: string;
  /** The provider project path or id, without the host. */
  projectId: string;
  /** The provider host, when the platform names one. */
  host?: string;
}

/**
 * Read a canonical project key back into the parts a provider needs.
 *
 * This is the inverse of `canonicalProjectKey`: it turns the key a manifest
 * names into the platform, the project and the host a provider is created
 * for, so a record can be written in exactly the repository its key names.
 */
export function parseCanonicalProject(value: string): CanonicalProject {
  const separator = value.indexOf(':');
  if (separator < 0) throw new Error(`canonical project key must use platform:projectKey: ${value}`);
  const platform = parseWorkItemPlatform(value.slice(0, separator));
  const projectKey = parseProjectKey(value.slice(separator + 1));
  if (platform === 'github') {
    return { platform, projectKey, projectId: projectKey };
  }
  const host = gitLabProjectHost(projectKey);
  const projectId = host === undefined ? projectKey : projectKey.slice(host.length + 1);
  if (!projectId) throw new Error(`GitLab project key must include a project path: ${value}`);
  return { platform, projectKey, projectId, host };
}

export interface ParsedWorkItemId extends WorkItemIdentityParts {
  id: WorkItemId;
}

export function formatWorkItemId(parts: WorkItemIdentityParts): WorkItemId {
  const platform = parseWorkItemPlatform(parts.platform);
  const projectKey = parseProjectKey(parts.projectKey);
  const issueNumber = parseIssueNumber(parts.issueNumber);
  return `${platform}:${projectKey}#${issueNumber}` as WorkItemId;
}

export function parseWorkItemId(input: unknown): ParsedWorkItemId {
  if (typeof input !== 'string' || input.trim() !== input) throw new Error('work item ID must be a canonical string');
  const match = /^([^:]+):([^#]+)#([1-9]\d*)$/.exec(input);
  if (!match) throw new Error('work item ID must use platform:projectKey#issueNumber');

  const platform = parseWorkItemPlatform(match[1]);
  const projectKey = parseProjectKey(match[2]);
  const issueNumber = parseIssueNumber(Number(match[3]));
  const id = formatWorkItemId({ platform, projectKey, issueNumber });
  if (id !== input) throw new Error('work item ID is not canonical');

  return { id, platform, projectKey, issueNumber };
}

export function encodeWorkItemIdForPath(id: WorkItemId): string {
  const canonical = parseWorkItemId(id).id;
  return encodeURIComponent(canonical).replace(/[!'()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

function parseWorkItemPlatform(input: unknown): WorkItemPlatform {
  if (typeof input !== 'string' || !(WORK_ITEM_PLATFORMS as readonly string[]).includes(input)) {
    throw new Error(`work item platform must be one of: ${WORK_ITEM_PLATFORMS.join(', ')}`);
  }
  return input as WorkItemPlatform;
}

function parseProjectKey(input: unknown): string {
  if (!isWorkItemProjectKey(input)) {
    throw new Error('work item project key is invalid');
  }
  return input;
}

function parseIssueNumber(input: unknown): number {
  if (typeof input !== 'number' || !Number.isSafeInteger(input) || input <= 0) {
    throw new Error('work item issue number must be a positive safe integer');
  }
  return input;
}
