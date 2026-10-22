import type { WorkItem, WorkState } from '@afk/core';
import type {
  WorkItemInventoryDiagnostic,
  WorkItemInventoryPort,
} from './ports.js';

export interface ListWorkItemsInput {
  state?: WorkState;
  mode?: WorkItem['mode'];
  text?: string;
}

export interface ListWorkItemsResult {
  items: readonly WorkItem[];
  diagnostics: readonly WorkItemInventoryDiagnostic[];
  complete: boolean;
}

export async function listWorkItems(
  input: ListWorkItemsInput = {},
  ports: { inventory: WorkItemInventoryPort },
): Promise<ListWorkItemsResult> {
  const snapshot = await ports.inventory.list();
  const text = input.text?.trim().toLowerCase();
  const items = snapshot.items
    .filter(item => input.state === undefined || item.state === input.state)
    .filter(item => input.mode === undefined || item.mode === input.mode)
    .filter(item => text === undefined || item.id.toLowerCase().includes(text) || item.title.toLowerCase().includes(text))
    .slice()
    .sort(compareWorkItems);

  return {
    items,
    diagnostics: [...snapshot.diagnostics],
    complete: snapshot.complete,
  };
}

function compareWorkItems(left: WorkItem, right: WorkItem): number {
  return compareText(left.id, right.id) || compareText(left.title, right.title);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
