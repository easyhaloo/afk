import type { BacklogExecutionMode, BacklogState } from '../backlog/index.js';
import type { GlobalWorkItem, ProviderProjectRef, WorkItemPlatform } from './types.js';

export type { GlobalWorkItem, ProviderProjectRef } from './types.js';

export interface ProviderIssue {
  issueNumber: number;
  title: string;
  description?: string;
  labels: string[];
  state: 'opened' | 'closed';
  webUrl?: string;
  updatedAt?: string;
}

export interface ProviderCatalog {
  platform: WorkItemPlatform;
  scopeKey: string;
  /**
   * Resolve the authenticated account behind this catalog. It is optional
   * because a catalog may be unable to verify its account; the resolver
   * reports that as a per-catalog failure instead of aborting the whole set.
   */
  getAccountIdentity?: () => Promise<ProviderAccountIdentity>;
  listProjects(): Promise<CatalogPageResult<ProviderProjectRef>>;
  listIssues(project: ProviderProjectRef): Promise<CatalogPageResult<ProviderIssue>>;
}

export interface ProviderAccountIdentity {
  platform: WorkItemPlatform;
  host: string;
  accountId: string;
}

export interface ProviderAccountIdentityFailure {
  platform: WorkItemPlatform;
  scopeKey: string;
  message: string;
}

export type CatalogPageResult<T> = T[] | { items: T[]; error: unknown };

export interface InventoryDiagnostic {
  platform: WorkItemPlatform;
  projectKey: string;
  code: string;
  message: string;
  retryable: boolean;
}

export interface GlobalWorkItemInventoryResult {
  items: GlobalWorkItem[];
  projects: ProviderProjectRef[];
  diagnostics: InventoryDiagnostic[];
  complete: boolean;
}

export interface GlobalWorkItemInventoryFilters {
  state?: BacklogState;
  mode?: BacklogExecutionMode;
  /** Filter by role; `prd` selects the organizational anchors. */
  kind?: 'prd';
  tag?: string;
  project?: string;
}

export class ProviderCatalogError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'ProviderCatalogError';
  }
}
