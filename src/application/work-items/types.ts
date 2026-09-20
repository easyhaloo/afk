import type { BacklogExecutionMode, BacklogState } from '../../domain/backlog';
import type { GlobalWorkItem, ProviderProjectRef, WorkItemPlatform } from '../../domain/work-item/types';

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
