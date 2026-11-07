import type { EvidenceClassification, EvidenceRef, ObservationContext, RunEvent, RunEventDraft } from './events.js';

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

export type HostFailureCode =
  | 'binary-missing'
  | 'server-unknown'
  | 'auth-required'
  | 'asset-unknown'
  | 'unreachable'
  | 'remote-failed';

export const HOST_FAILURE_SUGGESTIONS: Readonly<Record<HostFailureCode, string>> = {
  'binary-missing': '安装连接适配器或确认其已在 PATH 中',
  'server-unknown': '查看已配置的跳板机别名',
  'auth-required': '重新登录或更新连接凭据',
  'asset-unknown': '检查目标资产名称或重新认领资产',
  unreachable: '检查网络、VPN 或跳板机状态',
  'remote-failed': '查看远程 stderr 和退出码',
};

export class HostFailure extends Error {
  readonly code: HostFailureCode;
  readonly suggestion: string;

  constructor(code: HostFailureCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'HostFailure';
    this.code = code;
    this.suggestion = HOST_FAILURE_SUGGESTIONS[code];
  }
}

export interface HostRecord {
  readonly id: string;
  readonly alias: string;
  readonly address?: string;
  readonly provider: string;
  readonly lastVerifiedAt?: string;
}

export interface HostExecResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface HostConnectionPort {
  listHosts(): Promise<readonly HostRecord[]>;
  resolve(host: string): Promise<HostRecord>;
  exec(host: string, argv: readonly string[], options?: { timeoutMs?: number }): Promise<HostExecResult>;
  upload?(host: string, source: string, destination: string, options?: { timeoutMs?: number }): Promise<void>;
}

export interface CoreRuntimePorts {
  events: EventStorePort;
  evidence: EvidenceStorePort;
  tracer: TracerPort;
  metrics: MetricsPort;
  clock: ClockPort;
  ids: IdPort;
}
