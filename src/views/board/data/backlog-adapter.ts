import type {
  BacklogItem,
  BacklogListOptions,
} from '../../../lib/core/backlog';

/**
 * Capability boundary exposed to the TUI. Keep this structural type narrow so
 * a view cannot accidentally acquire transition, tagging, or claim methods.
 */
export interface TuiBacklogProvider {
  list(options?: BacklogListOptions): Promise<BacklogItem[]>;
}

export interface TuiManagementProviderBundle {
  backlog: TuiBacklogProvider;
}

/**
 * Read-only, provider-neutral shape consumed by the TUI backlog views.
 *
 * This deliberately contains canonical backlog fields only. Provider labels
 * (including workflow metadata labels) are not exposed to the presentation
 * layer; navigation uses the optional provider URL instead.
 */
export interface BacklogViewModel {
  id: string;
  title: string;
  description?: string;
  state: BacklogItem['state'];
  executionMode: BacklogItem['executionMode'];
  parentId?: string;
  dependsOn: string[];
  tags: string[];
  branchName: string;
  providerRef: string;
  webUrl?: string;
}

/** Convert a canonical backlog item into an immutable-enough TUI read model. */
export function toBacklogViewModel(item: BacklogItem): BacklogViewModel {
  return {
    id: item.id,
    title: item.title,
    description: item.description,
    state: item.state,
    executionMode: item.executionMode,
    parentId: item.parentId,
    dependsOn: [...item.dependsOn],
    tags: [...item.tags],
    branchName: item.branchName,
    providerRef: item.providerRef,
    webUrl: item.webUrl,
  };
}

/**
 * Load backlog rows through the claim-free management facade.
 *
 * The loader intentionally only touches `bundle.backlog.list()`: the TUI is
 * read-only and cannot accidentally invoke implementation claims or other
 * execution lifecycle operations.
 */
export async function loadBacklogViewModels(
  bundle: TuiManagementProviderBundle,
  options?: BacklogListOptions,
): Promise<BacklogViewModel[]> {
  const items = await bundle.backlog.list(options);
  return items.map(toBacklogViewModel);
}
