import type { GlobalWorkItem, ProviderProjectRef } from './types.js';
import { toGlobalWorkItem } from './metadata.js';
import {
  type GlobalWorkItemInventoryFilters,
  ProviderCatalogError,
  type GlobalWorkItemInventoryResult,
  type InventoryDiagnostic,
  type ProviderCatalog,
} from './provider-types.js';

interface CatalogProject {
  catalog: ProviderCatalog;
  project: ProviderProjectRef;
}

/**
 * How many provider requests the inventory may have in flight at once.
 *
 * The listing is network bound — one round trip per repository, or per owner
 * when the platform can filter server-side — so a low ceiling spends most of
 * the wall clock waiting. Twelve keeps the request rate well inside the
 * provider's secondary rate limits while removing the queueing delay.
 */
export const DEFAULT_INVENTORY_CONCURRENCY = 12;

export async function collectGlobalWorkItemInventory(
  catalogs: readonly ProviderCatalog[],
  concurrency = DEFAULT_INVENTORY_CONCURRENCY,
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
  const itemGroups = await collectIssues(projectEntries, concurrency, diagnostics);
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

/**
 * Collect the issues of every discovered project.
 *
 * A platform that can filter server-side answers the whole scope in one
 * round trip, which replaces one request per project. When that capability
 * is missing or fails, the per-project listing is used instead, so the
 * inventory always covers the same set of issues.
 */
async function collectIssues(
  projectEntries: readonly CatalogProject[],
  concurrency: number,
  diagnostics: InventoryDiagnostic[],
): Promise<GlobalWorkItem[][]> {
  const byCatalog = new Map<ProviderCatalog, CatalogProject[]>();
  for (const entry of projectEntries) {
    const group = byCatalog.get(entry.catalog);
    if (group) group.push(entry);
    else byCatalog.set(entry.catalog, [entry]);
  }

  const groups: GlobalWorkItem[][] = [];
  await mapLimit([...byCatalog.values()], concurrency, async entries => {
    const catalog = entries[0].catalog;
    if (catalog.listIssuesAcrossScope) {
      const result = await catalog.listIssuesAcrossScope(entries.map(entry => entry.project));
      if (Array.isArray(result)) {
        groups.push(result.map(entry => toGlobalWorkItem(entry.project, entry.issue)));
        return;
      }
      diagnostics.push(toDiagnostic(catalog.platform, catalog.scopeKey, 'scope_issue_list_failed', result.error));
    }
    const perProject = await mapLimit(entries, concurrency, async ({ project }) => {
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
    groups.push(...perProject);
  });
  return groups;
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
