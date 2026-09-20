import type { GlobalWorkItem, ProviderProjectRef } from '../../domain/work-item/types';
import { toGlobalWorkItem } from './metadata';
import {
  type GlobalWorkItemInventoryFilters,
  ProviderCatalogError,
  type GlobalWorkItemInventoryResult,
  type InventoryDiagnostic,
  type ProviderCatalog,
} from './types';

interface CatalogProject {
  catalog: ProviderCatalog;
  project: ProviderProjectRef;
}

export async function collectGlobalWorkItemInventory(
  catalogs: readonly ProviderCatalog[],
  concurrency = 4,
): Promise<GlobalWorkItemInventoryResult> {
  const diagnostics: InventoryDiagnostic[] = [];
  const discovered: CatalogProject[] = [];

  await mapLimit(catalogs, concurrency, async catalog => {
    try {
      const result = await catalog.listProjects();
      const projects = Array.isArray(result) ? result : result.items;
      discovered.push(...projects.map(project => ({ catalog, project })));
      if (!Array.isArray(result)) {
        diagnostics.push(toDiagnostic(catalog.platform, catalog.scopeKey, 'project_list_failed', result.error));
      }
    } catch (error) {
      diagnostics.push(toDiagnostic(catalog.platform, catalog.scopeKey, 'project_list_failed', error));
    }
  });

  const uniqueProjects = new Map<string, CatalogProject>();
  for (const entry of discovered) {
    const key = `${entry.project.platform}:${entry.project.projectKey}`;
    if (!uniqueProjects.has(key)) uniqueProjects.set(key, entry);
  }
  const projectEntries = [...uniqueProjects.values()].sort((left, right) => compareProjects(left.project, right.project));
  const itemGroups = await mapLimit(projectEntries, concurrency, async ({ catalog, project }) => {
    try {
      const result = await catalog.listIssues(project);
      const issues = Array.isArray(result) ? result : result.items;
      if (!Array.isArray(result)) {
        diagnostics.push(toDiagnostic(project.platform, project.projectKey, 'issue_list_failed', result.error));
      }
      return issues.map(issue => toGlobalWorkItem(project, issue));
    } catch (error) {
      diagnostics.push(toDiagnostic(project.platform, project.projectKey, 'issue_list_failed', error));
      return [];
    }
  });
  const items = itemGroups.flat().sort(compareItems);

  diagnostics.sort((left, right) =>
    left.platform.localeCompare(right.platform)
    || left.projectKey.localeCompare(right.projectKey)
    || left.code.localeCompare(right.code));

  return {
    items,
    projects: projectEntries.map(entry => entry.project),
    diagnostics,
    complete: diagnostics.length === 0,
  };
}

export function filterGlobalWorkItemInventory(
  result: GlobalWorkItemInventoryResult,
  filters: GlobalWorkItemInventoryFilters,
): GlobalWorkItemInventoryResult {
  const matchesProject = (projectKey: string): boolean => filters.project === undefined || projectKey === filters.project;
  const diagnostics = result.diagnostics.filter(diagnostic =>
    matchesProject(diagnostic.projectKey)
    || (filters.project !== undefined && diagnostic.code === 'project_list_failed' && (
      diagnostic.platform === 'github' && diagnostic.projectKey === 'github.com'
      || diagnostic.platform === 'gitlab' && filters.project.startsWith(`${diagnostic.projectKey}/`)
    )));
  return {
    ...result,
    projects: result.projects.filter(project => matchesProject(project.projectKey)),
    diagnostics,
    complete: diagnostics.length === 0,
    items: result.items.filter(item =>
      matchesProject(item.project.projectKey)
      && (filters.state === undefined || item.state === filters.state)
      && (filters.mode === undefined || item.executionMode === filters.mode)
      && (filters.tag === undefined || item.tags.includes(filters.tag))),
  };
}

function compareProjects(left: ProviderProjectRef, right: ProviderProjectRef): number {
  return left.platform.localeCompare(right.platform)
    || left.projectKey.localeCompare(right.projectKey);
}

function compareItems(left: GlobalWorkItem, right: GlobalWorkItem): number {
  return left.project.platform.localeCompare(right.project.platform)
    || left.project.projectKey.localeCompare(right.project.projectKey)
    || left.issueNumber - right.issueNumber;
}

function toDiagnostic(
  platform: ProviderProjectRef['platform'],
  projectKey: string,
  fallbackCode: string,
  error: unknown,
): InventoryDiagnostic {
  if (error instanceof ProviderCatalogError) {
    return { platform, projectKey, code: error.code, message: error.message, retryable: error.retryable };
  }
  const message = error instanceof Error ? error.message : String(error);
  return {
    platform,
    projectKey,
    code: fallbackCode,
    message,
    retryable: /\b(408|425|429|5\d\d)\b|timeout|temporar/i.test(message),
  };
}

async function mapLimit<T, R>(
  values: readonly T[],
  concurrency: number,
  worker: (value: T) => Promise<R>,
): Promise<R[]> {
  const limit = Math.max(1, Math.floor(concurrency));
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (nextIndex < values.length) {
      const index = nextIndex++;
      results[index] = await worker(values[index]);
    }
  }));
  return results;
}
