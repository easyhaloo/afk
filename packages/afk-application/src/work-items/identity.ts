export const WORK_ITEM_PLATFORMS = ['github', 'gitlab'] as const;

export type WorkItemPlatform = typeof WORK_ITEM_PLATFORMS[number];

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
  if (typeof input !== 'string' || !input || input.trim() !== input || /[:#\s\x00-\x1f\x7f]/.test(input) || input.split('/').some(segment => segment === '.' || segment === '..')) {
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
