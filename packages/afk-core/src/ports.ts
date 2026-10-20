import type { EvidenceClassification, EvidenceRef, ObservationContext, RunEvent, RunEventDraft } from './events.js';

export interface AppendReceipt {
  runId: string;
  firstSequence: number;
  lastSequence: number;
  lastHash: string;
}

/**
 * The result of checking a run's event chain.
 *
 * `lastSequence` is the sequence of the last event the chain vouches for, so
 * the events up to it form a contiguous, verified prefix. It is the boundary
 * a reader may trust: on a broken chain the events beyond it are not known to
 * be what they claim to be, and a state derived from them would be a state
 * derived from a forgery.
 */
export interface EventChainIntegrity {
  valid: boolean;
  lastSequence: number;
  lastHash?: string;
  reason?: string;
}

export interface EventStorePort {
  append(events: readonly RunEventDraft[]): Promise<AppendReceipt>;
  read(runId: string, options?: { afterSequence?: number }): AsyncIterable<RunEvent>;
  listRuns(): Promise<readonly string[]>;
  verify(runId: string): Promise<EventChainIntegrity>;

  /**
   * A signature of what the store holds for a run, when it can tell.
   *
   * A reader that caches a projection of a run asks the store whether the
   * run has changed, rather than guessing how the store lays its files out:
   * the signature changes when the run's stored state does. A store that
   * cannot tell returns undefined, and the reader reads the run again.
   */
  revision?(runId: string): Promise<string | undefined>;

  /**
   * A directory a reader may keep a cache of this store's contents in.
   *
   * The cache belongs to the reader, but it belongs next to the data it
   * describes. A store that has no such place offers none, and the reader
   * keeps no cache.
   */
  cacheDirectory?(): string | undefined;
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
