export type InventoryPlatform = 'github' | 'gitlab';
export type InventoryState = 'prd' | 'ready' | 'rework' | 'in_progress' | 'verification' | 'merge_ready' | 'done' | 'blocked';

export interface InventoryProject {
  platform: InventoryPlatform;
  projectKey: string;
  providerHost?: string;
  providerProjectId?: string;
  name: string;
  defaultBranch?: string;
  webUrl?: string;
}

export interface InventorySource {
  id: string;
  type: 'github_issue' | 'gitlab_issue' | 'external' | 'local';
  title: string;
  reference: string;
  role?: string;
  platform?: InventoryPlatform;
  projectKey?: string;
  issueNumber?: number;
  webUrl?: string;
}

export interface InventoryRepository extends InventoryProject {
  id?: string;
  role?: string;
  checkoutPath?: string;
  baseBranch: string;
}

export interface InventoryRunRepository {
  platform: InventoryPlatform;
  projectKey: string;
  providerHost?: string;
  providerProjectId?: string;
  name: string;
  checkoutPath: string;
  baseBranch: string;
  role?: string;
}

export interface InventoryRun {
  id: string;
  status: 'starting' | 'running' | 'completed' | 'failed';
  startedAt: string;
  completedAt?: string;
  workflow?: string;
  workingBranch?: string;
  repositories?: InventoryRunRepository[];
  workspacePath?: string;
  pid?: number;
  error?: string;
}

export interface InventoryStep {
  id: string;
  title: string;
  detail?: string;
  status?: 'pending' | 'running' | 'completed' | 'blocked';
}

export interface InventoryItem {
  id: string;
  issueNumber: number;
  project: InventoryProject;
  title: string;
  description?: string;
  managed: boolean;
  executionEligible: boolean;
  state: InventoryState;
  executionMode: 'afk' | 'hitl';
  parentId?: string;
  dependsOn: string[];
  tags: string[];
  branchName: string;
  providerRef: string;
  webUrl?: string;
  sources?: InventorySource[];
  repositories?: InventoryRepository[];
  executionPlan?: InventoryStep[];
  runs?: InventoryRun[];
  owner?: string;
  priority?: 'P0' | 'P1' | 'P2' | 'P3';
  updatedAt?: string;
}

export interface InventoryDiagnostic {
  platform: InventoryPlatform;
  projectKey?: string;
  code: string;
  message: string;
  retryable: boolean;
}

export interface InventorySnapshot {
  items: InventoryItem[];
  projects: InventoryProject[];
  diagnostics: InventoryDiagnostic[];
  complete: boolean;
}

export interface InventoryQuery {
  platform?: InventoryPlatform | 'all';
  state?: InventoryState;
  executionMode?: 'afk' | 'hitl';
  project?: string;
  tag?: string;
  text?: string;
  /** Canonical identity of the organizational parent; answers "the children of". */
  parentId?: string;
  limit?: number;
  cursor?: string;
}

export interface InventoryPage<Item> {
  items: Item[];
  nextCursor?: string;
  revision: number;
  lastSuccessAt?: number;
  complete: boolean;
  diagnostics: InventoryDiagnostic[];
}

export interface InventoryScope {
  platform: InventoryPlatform;
  host: string;
  kind: 'catalog' | 'issues';
  projectKey?: string;
}

export interface InventoryAttempt {
  scope: InventoryScope;
  sequence: number;
}

export interface LocalInventoryStore {
  begin(scope: InventoryScope): Promise<InventoryAttempt>;
  publish(attempt: InventoryAttempt, snapshot: InventorySnapshot): Promise<boolean>;
  fail(attempt: InventoryAttempt, diagnostic: InventoryDiagnostic): Promise<boolean>;
  query(input?: InventoryQuery): Promise<InventoryPage<InventoryItem>>;
  repositories(input?: Pick<InventoryQuery, 'platform' | 'text' | 'limit' | 'cursor'>): Promise<InventoryPage<InventoryProject>>;
  get(id: string): Promise<InventoryItem | undefined>;
  titles(ids: readonly string[]): Promise<Array<{ id: string; title?: string }>>;
}

export async function refreshLocalInventory(
  scope: InventoryScope,
  dependencies: { store: LocalInventoryStore; load: () => Promise<InventorySnapshot> },
): Promise<InventorySnapshot> {
  const attempt = await dependencies.store.begin(scope);
  try {
    const snapshot = await dependencies.load();
    await dependencies.store.publish(attempt, snapshot);
    return snapshot;
  } catch (error) {
    await dependencies.store.fail(attempt, {
      platform: scope.platform,
      projectKey: scope.projectKey,
      code: 'inventory_refresh_failed',
      message: error instanceof Error ? error.message : 'Inventory refresh failed',
      retryable: true,
    });
    throw error;
  }
}
