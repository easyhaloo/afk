import type { BacklogExecutionMode, BacklogState } from './backlog-mapping.js';
import type { GlobalWorkItemPlatform, WorkItemPlatform } from './work-items/identity.js';

export interface ProviderInventoryQuery {
  platform?: GlobalWorkItemPlatform;
  state?: BacklogState;
  executionMode?: BacklogExecutionMode;
  tag?: string;
  project?: string;
}

export interface ProviderInventoryItem {
  project: { platform: WorkItemPlatform; projectKey: string };
  state: BacklogState;
  executionMode: BacklogExecutionMode;
  tags: readonly string[];
}

export interface ProviderInventoryProject {
  platform: WorkItemPlatform;
  projectKey: string;
}

export interface ProviderInventoryDiagnostic {
  platform: WorkItemPlatform;
  projectKey?: string;
  code: string;
}

export interface ProviderInventorySnapshot<Item extends ProviderInventoryItem, Project extends ProviderInventoryProject, Diagnostic extends ProviderInventoryDiagnostic> {
  items: readonly Item[];
  projects: readonly Project[];
  diagnostics: readonly Diagnostic[];
  complete: boolean;
}

export interface ProviderInventoryPort<Item extends ProviderInventoryItem, Project extends ProviderInventoryProject, Diagnostic extends ProviderInventoryDiagnostic> {
  list(platform: GlobalWorkItemPlatform): Promise<ProviderInventorySnapshot<Item, Project, Diagnostic>>;
}

export async function queryProviderInventory<Item extends ProviderInventoryItem, Project extends ProviderInventoryProject, Diagnostic extends ProviderInventoryDiagnostic>(
  input: ProviderInventoryQuery,
  inventory: ProviderInventoryPort<Item, Project, Diagnostic>,
): Promise<ProviderInventorySnapshot<Item, Project, Diagnostic>> {
  const snapshot = await inventory.list(input.platform ?? 'all');
  const matchesProject = (projectKey: string) => input.project === undefined || projectKey === input.project;
  const diagnostics = snapshot.diagnostics.filter(diagnostic =>
    (input.platform === undefined || input.platform === 'all' || diagnostic.platform === input.platform)
    && (matchesProject(diagnostic.projectKey ?? '')
    || (input.project !== undefined && diagnostic.code === 'project_list_failed' && (
      diagnostic.platform === 'github' && diagnostic.projectKey === 'github.com'
      || diagnostic.platform === 'gitlab' && input.project.startsWith(`${diagnostic.projectKey}/`)
    ))));
  return {
    items: snapshot.items.filter(item =>
      (input.platform === undefined || input.platform === 'all' || item.project.platform === input.platform)
      && matchesProject(item.project.projectKey)
      && (input.state === undefined || item.state === input.state)
      && (input.executionMode === undefined || item.executionMode === input.executionMode)
      && (input.tag === undefined || item.tags.includes(input.tag))),
    projects: snapshot.projects.filter(project =>
      (input.platform === undefined || input.platform === 'all' || project.platform === input.platform)
      && matchesProject(project.projectKey)),
    diagnostics,
    complete: diagnostics.length === 0,
  };
}
