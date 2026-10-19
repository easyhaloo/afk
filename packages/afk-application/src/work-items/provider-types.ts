import type { BacklogExecutionMode, BacklogState } from '../backlog-mapping.js';
import type { GlobalWorkItem, ProviderProjectRef } from './types.js';
import type { WorkItemPlatform } from './identity.js';

export interface ProviderIssue {
  issueNumber: number;
  title: string;
  description?: string;
  labels: string[];
  state: 'opened' | 'closed';
  webUrl?: string;
}

export interface ProviderCatalog {
  platform: WorkItemPlatform;
  scopeKey: string;
  listProjects(): Promise<CatalogPageResult<ProviderProjectRef>>;
  listIssues(project: ProviderProjectRef): Promise<CatalogPageResult<ProviderIssue>>;
  /**
   * Optional: list the issues of every project in the scope in one round
   * trip, when the platform can filter server-side (a scoped issue search,
   * a global issue feed). Platforms without this capability fall back to one
   * request per project, which is the slow path.
   *
   * The result carries the owning project for every issue and must be
   * restricted to the projects that were passed in, so that a scope-wide
   * listing never widens the inventory.
   */
  listIssuesAcrossScope?(projects: readonly ProviderProjectRef[]): Promise<CatalogPageResult<ScopedProviderIssue>>;
}

/** An issue together with the project that owns it. */
export interface ScopedProviderIssue {
  issue: ProviderIssue;
  project: ProviderProjectRef;
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
