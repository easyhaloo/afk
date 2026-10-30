import type { BacklogExecutionMode, BacklogState, Runnability } from '../backlog/index.js';
import type { WorkItemId, WorkItemPlatform, WorkItemScope } from './identity.js';

export type { ParsedWorkItemId, WorkItemId, WorkItemIdentityParts, WorkItemPlatform, WorkItemScope } from './identity.js';

export interface ProviderProjectRef {
  platform: WorkItemPlatform;
  projectKey: string;
  providerHost?: string;
  providerProjectId?: string;
  name: string;
  defaultBranch?: string;
  webUrl?: string;
}

export interface GlobalWorkItem {
  id: WorkItemId;
  issueNumber: number;
  project: ProviderProjectRef;
  title: string;
  description?: string;
  managed: boolean;
  executionEligible: boolean;
  /** The lifecycle position. A PRD anchor is a container and has none. */
  state?: BacklogState;
  /** The role of the item; `prd` marks a parent that is never executable. */
  kind?: 'prd';
  executionMode: BacklogExecutionMode;
  parentId?: WorkItemId;
  dependsOn: WorkItemId[];
  tags: string[];
  branchName: string;
  providerRef: string;
  webUrl?: string;
  updatedAt?: string;
  /**
   * Whether the item may start, and what holds it back.
   *
   * Filled in by the surfaces that can see the whole inventory: the answer
   * depends on the dependencies and the children of the item, which a
   * single item's own record does not carry.
   */
  runnability?: Runnability;
}
