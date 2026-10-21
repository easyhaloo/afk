/**
 * The one grammar for a work item identity.
 *
 * A work item is named by three parts — the platform it lives on, the
 * project it belongs to, and the issue number inside that project — and
 * those three parts are what every part of AFK agrees on.  The desktop
 * client, the CLI, the tracker adapters and the execution runtime all
 * have to reach the same verdict about the same string, because an
 * identity that one of them reads and another one rejects shows up as an
 * empty list or a run that dies halfway through.
 *
 * So the rules live here, once, and the other layers call them instead of
 * writing their own.
 */

export const WORK_ITEM_PLATFORMS = ['github', 'gitlab'] as const;

export type WorkItemPlatform = typeof WORK_ITEM_PLATFORMS[number];

/**
 * The platforms a query can span.
 *
 * 'all' means every platform there is. It is a query and not a place a
 * work item can come from, so it is not part of the identity grammar.
 */
export const GLOBAL_WORK_ITEM_PLATFORMS = [...WORK_ITEM_PLATFORMS, 'all'] as const;

export type GlobalWorkItemPlatform = typeof GLOBAL_WORK_ITEM_PLATFORMS[number];

declare const workItemIdBrand: unique symbol;

export type WorkItemId = string & { readonly [workItemIdBrand]: 'WorkItemId' };

export interface WorkItemIdentityParts {
  platform: WorkItemPlatform;
  projectKey: string;
  issueNumber: number;
}

export interface ParsedWorkItemId extends WorkItemIdentityParts {
  id: WorkItemId;
}

/**
 * Whether a value names a platform AFK can reach.
 */
export function isWorkItemPlatform(value: unknown): value is WorkItemPlatform {
  return typeof value === 'string' && (WORK_ITEM_PLATFORMS as readonly string[]).includes(value);
}

/**
 * The platform a work item lives on.
 */
export function validateWorkItemPlatform(value: unknown, label = 'work item platform'): WorkItemPlatform {
  if (!isWorkItemPlatform(value)) {
    throw new Error(`${label} must be one of: ${WORK_ITEM_PLATFORMS.join(', ')}`);
  }
  return value;
}

/**
 * The project key of a work item.
 *
 * A project key names a project on a provider — "owner/repository" on
 * GitHub, "host/group/subgroup/project" on GitLab.  It becomes part of a
 * path and part of a branch name, so it may not be empty, may not carry
 * whitespace, a colon, a hash or a control character, and may not contain
 * an empty, "." or ".." path segment: "acme//api" and "acme/../api" would
 * both name something other than the project they claim to.
 */
export function validateWorkItemProjectKey(value: unknown, label = 'work item project key'): string {
  if (
    typeof value !== 'string'
    || !value
    || value.trim() !== value
    || /[:#\s\x00-\x1f\x7f]/.test(value)
    || value.split('/').some(segment => !segment || segment === '.' || segment === '..')
  ) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

/**
 * The issue number of a work item.
 *
 * Issue numbers count from one and are used as a path segment, so they
 * have to be a positive safe integer.
 */
export function validateWorkItemIssueNumber(value: unknown, label = 'work item issue number'): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return value;
}

/**
 * Whether a value is a work item id the identity grammar accepts.
 *
 * The canonical form is the one the execution runtime acts on: it parses
 * every work item id before it runs one, so an id outside that form names
 * something no run can be started for.
 */
export function isCanonicalWorkItemId(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  try {
    parseWorkItemId(value);
    return true;
  } catch {
    return false;
  }
}

export function formatWorkItemId(parts: WorkItemIdentityParts): WorkItemId {
  const platform = validateWorkItemPlatform(parts.platform);
  const projectKey = validateWorkItemProjectKey(parts.projectKey);
  const issueNumber = validateWorkItemIssueNumber(parts.issueNumber);
  return `${platform}:${projectKey}#${issueNumber}` as WorkItemId;
}

export function parseWorkItemId(input: unknown): ParsedWorkItemId {
  if (typeof input !== 'string' || input.trim() !== input) throw new Error('work item ID must be a canonical string');
  const match = /^([^:]+):([^#]+)#([1-9]\d*)$/.exec(input);
  if (!match) throw new Error('work item ID must use platform:projectKey#issueNumber');

  const platform = validateWorkItemPlatform(match[1]);
  const projectKey = validateWorkItemProjectKey(match[2]);
  const issueNumber = validateWorkItemIssueNumber(Number(match[3]));
  const id = formatWorkItemId({ platform, projectKey, issueNumber });
  if (id !== input) throw new Error('work item ID is not canonical');

  return { id, platform, projectKey, issueNumber };
}

export function encodeWorkItemIdForPath(id: WorkItemId): string {
  const canonical = parseWorkItemId(id).id;
  return encodeURIComponent(canonical).replace(/[!'()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}
