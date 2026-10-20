import type {
  AppendReceipt,
  EventChainIntegrity,
  RunEvent,
  RunEventDraft,
  WorkItem,
} from '@afk/core';

export interface WorkItemInventoryDiagnostic {
  code: string;
  message: string;
  retryable: boolean;
}

export interface WorkItemInventorySnapshot {
  items: readonly WorkItem[];
  diagnostics: readonly WorkItemInventoryDiagnostic[];
  complete: boolean;
}

export interface WorkItemInventoryPort {
  list(): Promise<WorkItemInventorySnapshot>;
}

export interface RunEventQueryPort {
  read(runId: string, options?: { afterSequence?: number }): AsyncIterable<RunEvent>;
  listRuns(): Promise<readonly string[]>;
  verify(runId: string): Promise<EventChainIntegrity>;
}

export interface RunEventCommandPort extends RunEventQueryPort {
  append(events: readonly RunEventDraft[]): Promise<AppendReceipt>;
}

export interface RunCommandPorts {
  events: RunEventCommandPort;
  ids: { next(): string };
  clock: { now(): Date };
}
