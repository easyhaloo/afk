import type { TrackerProvider } from '../../domain/tracker/types';
import type {
  BacklogCreateInput,
  BacklogItem,
  BacklogListOptions,
  BacklogManagementProvider,
} from '../../domain/backlog';
import type { GlobalWorkItem, ProviderProjectRef } from '../../domain/work-item/types';
import { parseWorkItemId } from '../../domain/work-item/identity';
import { collectGlobalWorkItemInventory } from './inventory';
import { toGlobalWorkItem } from './metadata';
import type { ProviderCatalog, ProviderIssue } from './types';
import {
  createGitHubTracker,
  createGitLabTracker,
  createGlobalWorkItemCatalogs,
  type GlobalTrackerPlatform,
} from '../tracker-provider-factory';

export type InventoryBacklogProviderDeps = {
  platform?: GlobalTrackerPlatform;
  catalogs?: () => ProviderCatalog[];
  trackerFor?: (project: ProviderProjectRef) => Promise<TrackerProvider>;
};

export function isProjectDetectionFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /No git remote found|Could not determine (GitHub repository|GitLab project)|Could not detect \w+ project from git remote/.test(message);
}

function gitLabApiProject(project: ProviderProjectRef): { projectId: string; host?: string } {
  const host = project.providerHost ?? project.projectKey.split('/')[0];
  const prefix = `${host}/`;
  const projectId = project.providerProjectId
    ?? (project.projectKey.startsWith(prefix) ? project.projectKey.slice(prefix.length) : project.projectKey);
  return { projectId, host };
}

async function defaultTrackerFor(project: ProviderProjectRef): Promise<TrackerProvider> {
  if (project.platform === 'github') return createGitHubTracker(project.projectKey);
  const { projectId, host } = gitLabApiProject(project);
  return createGitLabTracker(projectId, undefined, host);
}

function toBacklogItem(item: GlobalWorkItem): BacklogItem {
  return {
    id: item.id,
    workItemId: item.id,
    issueNumber: item.issueNumber,
    project: item.project,
    managed: item.managed,
    executionEligible: item.executionEligible,
    title: item.title,
    ...(item.description === undefined ? {} : { description: item.description }),
    ...(item.parentId === undefined ? {} : { parentId: item.parentId }),
    dependsOn: [...item.dependsOn],
    state: item.state,
    executionMode: item.executionMode,
    tags: [...item.tags],
    branchName: item.branchName,
    providerRef: item.providerRef,
    ...(item.webUrl === undefined ? {} : { webUrl: item.webUrl }),
  };
}

/**
 * Credential-scoped backlog provider: discovery and reads work from any
 * directory because projects come from gh/glab auth, never a local git remote.
 * Write operations target one project and require the repo-scoped CLI path.
 */
export class InventoryBacklogProvider implements BacklogManagementProvider {
  private readonly platform: GlobalTrackerPlatform;
  private readonly catalogs: () => ProviderCatalog[];
  private readonly trackerFor: (project: ProviderProjectRef) => Promise<TrackerProvider>;

  constructor(deps: InventoryBacklogProviderDeps = {}) {
    this.platform = deps.platform ?? 'all';
    this.catalogs = deps.catalogs ?? (() => createGlobalWorkItemCatalogs(this.platform));
    this.trackerFor = deps.trackerFor ?? defaultTrackerFor;
  }

  async list(options: BacklogListOptions = {}): Promise<BacklogItem[]> {
    const inventory = await collectGlobalWorkItemInventory(this.catalogs());
    return inventory.items
      .filter(item => item.managed)
      .filter(item => options.state === undefined || item.state === options.state)
      .filter(item => options.executionMode === undefined || item.executionMode === options.executionMode)
      .filter(item => options.parentId === undefined || item.parentId === options.parentId)
      .filter(item => options.tag === undefined || item.tags.includes(options.tag))
      .map(toBacklogItem);
  }

  async get(id: string): Promise<BacklogItem> {
    let parsed: ReturnType<typeof parseWorkItemId>;
    try {
      parsed = parseWorkItemId(id);
    } catch {
      throw new Error(`全局 Backlog 需要规范 ID（platform:project#number）：${id}`);
    }
    const project: ProviderProjectRef = {
      platform: parsed.platform,
      projectKey: parsed.projectKey,
      ...(parsed.platform === 'gitlab' ? { providerHost: parsed.projectKey.split('/')[0] } : {}),
      name: parsed.projectKey.split('/').filter(Boolean).at(-1) ?? parsed.projectKey,
    };
    const issue = await this.trackerFor(project).then(tracker => tracker.getIssue(parsed.issueNumber));
    const providerIssue: ProviderIssue = {
      issueNumber: issue.id,
      title: issue.title,
      description: issue.description,
      labels: issue.labels,
      state: issue.state === 'closed' ? 'closed' : 'opened',
      webUrl: issue.url,
    };
    return toBacklogItem(toGlobalWorkItem(project, providerIssue));
  }

  async create(_input: BacklogCreateInput): Promise<BacklogItem> {
    throw new Error('全局 Backlog 模式不能创建工作项；请在 Git 仓库目录内或使用 --project 指定项目');
  }

  async addTag(): Promise<void> {
    throw new Error('全局 Backlog 模式不能修改标签；请在 Git 仓库目录内或使用 --project 指定项目');
  }

  async removeTag(): Promise<void> {
    throw new Error('全局 Backlog 模式不能修改标签；请在 Git 仓库目录内或使用 --project 指定项目');
  }

  async initialize(): Promise<void> {
    // Credential-scoped discovery provisions no repository metadata.
  }
}
