import type { BacklogExecutionMode, BacklogState } from '../backlog/index';
import type { WorkItemId, WorkItemPlatform } from './identity';

export type { ParsedWorkItemId, WorkItemId, WorkItemIdentityParts, WorkItemPlatform } from './identity';

export interface ProviderProjectRef {
  platform: WorkItemPlatform;
  projectKey: string;
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
  state: BacklogState;
  executionMode: BacklogExecutionMode;
  parentId?: WorkItemId;
  dependsOn: WorkItemId[];
  tags: string[];
  branchName: string;
  providerRef: string;
  webUrl?: string;
}
