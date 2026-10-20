import type {
  AppendReceipt,
  EventChainIntegrity,
  ObservationContext,
  RunEvent,
  RunEventData,
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

/**
 * The one way to append an audit event.
 *
 * The event store's `append` is deliberately not part of this port: a caller
 * that hand-builds a draft and appends it directly stamps the event itself
 * and skips the log line, the metric and the trace the writer emits with
 * every event. The audit spine and the telemetry spine then disagree about
 * the same run.
 */
export interface AuditWriter {
  record(
    context: ObservationContext,
    data: RunEventData,
    options?: { causationId?: string; idempotencyKey?: string; evidence?: RunEventDraft['evidence'] },
  ): Promise<AppendReceipt>;
}

export interface RunCommandPorts {
  events: RunEventCommandPort;
  /** Appends audit events. The one writer, not the store. */
  audit: AuditWriter;
}
