import type { EvidenceClassification, EvidenceRef, ObservationContext, RunEvent, RunEventDraft } from './events';

export interface AppendReceipt {
  runId: string;
  firstSequence: number;
  lastSequence: number;
  lastHash: string;
}

export interface EventStorePort {
  append(events: readonly RunEventDraft[]): Promise<AppendReceipt>;
  read(runId: string, options?: { afterSequence?: number }): AsyncIterable<RunEvent>;
  listRuns(): Promise<readonly string[]>;
  verify(runId: string): Promise<{ valid: boolean; lastSequence: number; lastHash?: string; reason?: string }>;
}

export interface EvidenceStorePort {
  put(input: {
    bytes: Uint8Array;
    mediaType: string;
    classification: EvidenceClassification;
    redactionStatus: EvidenceRef['redactionStatus'];
  }): Promise<EvidenceRef>;
}

export interface TracerPort {
  within<T>(name: string, context: ObservationContext, operation: () => Promise<T>): Promise<T>;
  addEvent(context: ObservationContext, name: string, attributes?: Readonly<Record<string, string | number | boolean>>): void;
}

export interface MetricsPort {
  counter(name: string, value: number, attributes?: Readonly<Record<string, string | number | boolean>>): void;
  histogram(name: string, value: number, attributes?: Readonly<Record<string, string | number | boolean>>): void;
  gauge(name: string, value: number, attributes?: Readonly<Record<string, string | number | boolean>>): void;
}

export interface ClockPort {
  now(): Date;
}

export interface IdPort {
  next(): string;
}

export interface CoreRuntimePorts {
  events: EventStorePort;
  evidence: EvidenceStorePort;
  tracer: TracerPort;
  metrics: MetricsPort;
  clock: ClockPort;
  ids: IdPort;
}
