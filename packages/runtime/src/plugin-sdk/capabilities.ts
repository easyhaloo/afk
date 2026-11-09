/**
 * Provider-neutral plugin capability contracts.
 *
 * These interfaces describe what a cross-domain provider must expose so the
 * host can discover, health-check, and invoke it without knowing the concrete
 * vendor behind it. They are contracts only: no third-party SDK, Node/Electron
 * API, or business policy lives here. Each provider carries its own capability
 * token record, an optional health probe, an optional doctor diagnostic, and
 * accepts a caller-supplied abort signal so cancellation stays with the caller.
 */

/**
 * Structural subset of an abort signal. Declared locally so this module stays
 * free of DOM/Node type dependencies and works in any conformant runtime.
 */
export interface ProviderAbortSignal {
  readonly aborted: boolean;
  readonly reason?: unknown;
  addEventListener(type: 'abort', listener: () => void, options?: { readonly once?: boolean }): void;
  removeEventListener(type: 'abort', listener: () => void): void;
}

/** Options threaded through every provider operation that can be cancelled. */
export interface ProviderOperationOptions {
  readonly signal?: ProviderAbortSignal;
}

/** Outcome of a provider health probe. */
export type ProviderHealthStatus = 'ok' | 'degraded' | 'unavailable';

export interface ProviderHealth {
  readonly status: ProviderHealthStatus;
  readonly message?: string;
}

/** Single finding from a provider self-diagnostic (`doctor`). */
export interface ProviderDiagnostic {
  readonly check: string;
  readonly ok: boolean;
  readonly detail?: string;
}

/** Shared shape for every capability provider registered with the host. */
export interface CapabilityProvider<TCapabilities extends ProviderCapabilityToken> {
  /** Stable, host-unique provider identifier. */
  readonly id: string;
  /** Declares which optional operations this provider implements. */
  readonly capabilities: Readonly<Record<TCapabilities, boolean>>;
  /** Lightweight liveness/readiness probe. */
  health?(options?: ProviderOperationOptions): Promise<ProviderHealth>;
  /** Deeper self-diagnostic returning actionable findings. */
  doctor?(options?: ProviderOperationOptions): Promise<readonly ProviderDiagnostic[]>;
}

/** Minimal capability token type every provider record is keyed by. */
export type ProviderCapabilityToken = string;

// --- Verification ---

export type VerificationCapability = 'static-analysis' | 'test-execution' | 'custom-script';

export interface VerificationRequest {
  readonly target: string;
  readonly command?: readonly string[];
  readonly timeoutMs?: number;
}

export interface VerificationResult {
  readonly passed: boolean;
  readonly durationMs: number;
  readonly output?: string;
}

export interface VerificationProvider extends CapabilityProvider<VerificationCapability> {
  verify(request: VerificationRequest, options?: ProviderOperationOptions): Promise<VerificationResult>;
}

// --- Notification ---

export type NotificationCapability = 'direct-message' | 'channel-post' | 'mention';

export interface NotificationMessage {
  readonly title: string;
  readonly body: string;
  readonly channel?: string;
  readonly urgency?: 'low' | 'normal' | 'high';
}

export interface NotificationReceipt {
  readonly delivered: boolean;
  readonly channel: string;
  readonly error?: string;
}

export interface NotificationProvider extends CapabilityProvider<NotificationCapability> {
  notify(message: NotificationMessage, options?: ProviderOperationOptions): Promise<NotificationReceipt>;
}

// --- Trigger ---

export type TriggerCapability = 'schedule' | 'webhook' | 'manual';

export interface TriggerDescriptor {
  readonly id: string;
  readonly kind: TriggerCapability;
  readonly schedule?: string;
  readonly payload?: { readonly [key: string]: import('./profile.js').PluginConfigValue };
  readonly input?: { readonly [key: string]: import('./profile.js').PluginConfigValue };
}

export interface TriggerProvider extends CapabilityProvider<TriggerCapability> {
  register(trigger: TriggerDescriptor): Promise<void>;
  unregister(triggerId: string, options?: ProviderOperationOptions): Promise<void>;
}

// --- Context ---

export type ContextSourceCapability = 'read-only' | 'summarize' | 'search';

export interface ContextQuery {
  readonly scope: string;
  readonly prompt: string;
  readonly limit?: number;
}

export interface ContextFragment {
  readonly content: string;
  readonly origin: string;
  readonly score?: number;
}

export interface ContextSource extends CapabilityProvider<ContextSourceCapability> {
  gather(query: ContextQuery, options?: ProviderOperationOptions): Promise<readonly ContextFragment[]>;
}

// --- Credential ---

export type CredentialCapability = 'read' | 'rotate' | 'scoped-token';

export interface CredentialRef {
  readonly name: string;
  readonly scope?: string;
}

export interface CredentialValue {
  readonly secret: string;
  readonly expiresAt?: string;
}

export interface CredentialProvider extends CapabilityProvider<CredentialCapability> {
  resolve(ref: CredentialRef, options?: ProviderOperationOptions): Promise<CredentialValue>;
}

// --- Artifact ---

export type ArtifactSinkCapability = 'write' | 'read' | 'list';

export interface ArtifactDescriptor {
  readonly name: string;
  readonly mediaType: string;
  readonly bytes: Uint8Array;
}

export interface ArtifactRef {
  readonly uri: string;
  readonly name: string;
}

export interface ArtifactSink extends CapabilityProvider<ArtifactSinkCapability> {
  put(artifact: ArtifactDescriptor, options?: ProviderOperationOptions): Promise<ArtifactRef>;
}

// --- Repository ---

export type RepositoryLifecycleOperation = 'prepare' | 'checkout' | 'publish' | 'cleanup';

export type RepositoryCapability = 'read' | 'clone' | 'push' | RepositoryLifecycleOperation;

export interface RepositoryRef {
  readonly url: string;
  readonly ref?: string;
}

export interface RepositorySnapshot {
  readonly commit: string;
  readonly branch: string;
  readonly dirty: boolean;
}

export interface RepositoryPrepareRequest {
  readonly repository: RepositoryRef;
  readonly runId: string;
}

export interface RepositoryWorkspaceRequest {
  readonly workspaceId: string;
}

export interface RepositoryWorkspace {
  readonly id: string;
  readonly repository: RepositoryRef;
  readonly runId: string;
  readonly snapshot: RepositorySnapshot;
  readonly path?: string;
}

export interface RepositoryPublication {
  readonly commit: string;
  readonly branch: string;
  readonly url?: string;
}

export interface RepositoryCleanupResult {
  readonly removed: boolean;
}

export interface RepositoryProvider extends Omit<CapabilityProvider<RepositoryCapability>, 'capabilities'> {
  withLifecycleLease?<Result>(request: RepositoryPrepareRequest, operation: () => Promise<Result>, options?: ProviderOperationOptions): Promise<Result>;
  readonly capabilities: Readonly<Record<'read' | 'clone' | 'push', boolean> & Partial<Record<RepositoryLifecycleOperation, boolean>>>;
  snapshot(repository: RepositoryRef, options?: ProviderOperationOptions): Promise<RepositorySnapshot>;
  prepare?(request: RepositoryPrepareRequest, options?: ProviderOperationOptions): Promise<RepositoryWorkspace>;
  checkout?(request: RepositoryWorkspaceRequest, options?: ProviderOperationOptions): Promise<RepositoryWorkspace>;
  publish?(request: RepositoryWorkspaceRequest, options?: ProviderOperationOptions): Promise<RepositoryPublication>;
  cleanup?(request: RepositoryWorkspaceRequest, options?: ProviderOperationOptions): Promise<RepositoryCleanupResult>;
}

// --- Policy check ---

export type PolicyCheckCapability = 'pre-execution' | 'post-execution' | 'static-review';

export interface PolicyCheckInput {
  readonly action: string;
  readonly context?: Readonly<Record<string, string | number | boolean>>;
}

export interface PolicyDecision {
  readonly allowed: boolean;
  readonly rule?: string;
  readonly reason?: string;
}

export interface PolicyCheckProvider extends CapabilityProvider<PolicyCheckCapability> {
  evaluate(input: PolicyCheckInput, options?: ProviderOperationOptions): Promise<PolicyDecision>;
}

// --- Event store ---

export type EventStoreCapability = 'append' | 'read' | 'verify';

export interface EventRecord {
  readonly runId: string;
  readonly sequence: number;
  readonly type: string;
  readonly payload?: Readonly<{ readonly [key: string]: unknown }>;
}

export interface EventStoreProvider extends CapabilityProvider<EventStoreCapability> {
  append(events: readonly EventRecord[], options?: ProviderOperationOptions): Promise<void>;
  read(runId: string, options?: ProviderOperationOptions): Promise<readonly EventRecord[]>;
}

// --- Evidence store ---

export type EvidenceStoreCapability = 'put' | 'get' | 'classify';

export interface EvidenceRecord {
  readonly id: string;
  readonly mediaType: string;
  readonly bytes: Uint8Array;
  readonly classification?: string;
}

export interface EvidenceStoreProvider extends CapabilityProvider<EvidenceStoreCapability> {
  put(record: EvidenceRecord, options?: ProviderOperationOptions): Promise<ArtifactRef>;
  get(id: string, options?: ProviderOperationOptions): Promise<EvidenceRecord>;
}

// --- Tracer ---

export type TracerCapability = 'span' | 'event' | 'baggage';

export interface TraceContext {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId?: string;
}

export interface TraceSpanOptions extends ProviderOperationOptions {
  readonly attributes?: Readonly<Record<string, string | number | boolean>>;
}

export interface TracerProvider extends CapabilityProvider<TracerCapability> {
  startSpan(name: string, context: TraceContext, options?: TraceSpanOptions): Promise<void>;
  addEvent(context: TraceContext, name: string, options?: TraceSpanOptions): Promise<void>;
  endSpan?(context: TraceContext, options?: TraceSpanOptions & { readonly error?: boolean }): Promise<void>;
}

// --- Metrics ---

export type MetricsCapability = 'counter' | 'gauge' | 'histogram';

export interface MetricSample {
  readonly name: string;
  readonly value: number;
  readonly kind?: MetricsCapability;
  readonly attributes?: Readonly<Record<string, string | number | boolean>>;
}

export interface MetricsProvider extends CapabilityProvider<MetricsCapability> {
  record(sample: MetricSample, options?: ProviderOperationOptions): Promise<void>;
}
