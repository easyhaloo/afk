/**
 * Concrete trigger providers.
 *
 * These providers turn external or timed events into host callbacks. None of
 * them start a server or a listener on their own — delivery is always pull-based:
 * the host feeds a payload/signature to a `handle*` method, or, for schedules,
 * the provider arms an injectable interval timer.
 *
 * - `WebhookTriggerProvider` verifies an HMAC-SHA256 signature over the raw
 *   request body with `timingSafeEqual`, then dispatches matching registered
 *   events to an injected callback.
 * - `GitPushTriggerProvider` filters push payloads (branch, deletions) before
 *   dispatch.
 * - `IssueEventTriggerProvider` filters issue-event payloads (action, label)
 *   before dispatch.
 * - `ScheduleTriggerProvider` actually fires interval timers using injectable
 *   `setInterval`/`clearInterval`, taking `descriptor.schedule` as integer
 *   milliseconds and rejecting anything that is not a positive integer.
 *
 * All providers share a `register`/`unregister`/`dispose` lifecycle with
 * duplicate-id protection and deterministic timer cleanup.
 *
 * Shared SDK types are re-used; only provider-local shapes (payloads, handler
 * signatures, timer tokens) are declared here.
 */
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type {
  ProviderOperationOptions,
  TriggerCapability,
  TriggerDescriptor,
  TriggerProvider,
} from '../../plugin-sdk/capabilities.js';
import { checkAbort } from './dependencies.js';
import type { PluginConfigValue } from '../../plugin-sdk/profile.js';

// --- Shared lifecycle ---

/**
 * Base class implementing the register/unregister/dispose contract with
 * duplicate-id protection. Subclasses hook `assertDescriptor`, `activate` and
 * `deactivate` to arm and tear down per-trigger resources (e.g. timers).
 */
abstract class BaseTriggerProvider {
  abstract readonly id: string;
  abstract readonly capabilities: Readonly<Record<TriggerCapability, boolean>>;
  protected abstract readonly kind: TriggerCapability;

  protected readonly registered = new Map<string, TriggerDescriptor>();

  async register(descriptor: TriggerDescriptor, options?: ProviderOperationOptions): Promise<void> {
    checkAbort(options);
    if (!descriptor || typeof descriptor.id !== 'string' || !descriptor.id.trim()) throw new Error('Invalid trigger id');
    if (descriptor.kind !== this.kind) {
      throw new Error(`Expected a "${this.kind}" trigger, received "${descriptor.kind}"`);
    }
    if (this.registered.has(descriptor.id)) {
      throw new Error(`Trigger "${descriptor.id}" is already registered`);
    }
    if (descriptor.payload !== undefined && (!isObject(descriptor.payload) || !isJsonValue(descriptor.payload))) throw new Error('Invalid trigger payload');
    if (descriptor.input !== undefined && (!isObject(descriptor.input) || !isJsonValue(descriptor.input))) throw new Error('Invalid trigger action input');
    const registered = { ...descriptor, ...(descriptor.payload ? { payload: structuredClone(descriptor.payload) } : {}), ...(descriptor.input ? { input: structuredClone(descriptor.input) } : {}) };
    this.assertDescriptor(registered);
    this.registered.set(registered.id, registered);
    try {
      this.activate(registered);
    } catch (error) {
      try { this.deactivate(registered); } catch (cleanup) { throw new AggregateError([error, cleanup], 'Trigger activation and cleanup failed'); }
      finally { this.registered.delete(registered.id); }
      throw error;
    }
  }

  async unregister(triggerId: string, options?: ProviderOperationOptions): Promise<void> {
    checkAbort(options);
    const descriptor = this.registered.get(triggerId);
    if (!descriptor) throw new Error(`Unknown trigger "${triggerId}"`);
    this.deactivate(descriptor);
    this.registered.delete(triggerId);
  }

  async dispose(options?: ProviderOperationOptions): Promise<void> {
    checkAbort(options);
    const errors: unknown[] = [];
    for (const descriptor of [...this.registered.values()]) {
      try { await this.unregister(descriptor.id, options); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, 'Trigger disposal failed');
  }

  /** Validate a descriptor beyond kind/duplicate checks. */
  protected assertDescriptor(descriptor: TriggerDescriptor): void {
    void descriptor;
  }

  /** Arm per-trigger resources after a successful registration. */
  protected activate(descriptor: TriggerDescriptor): void {
    void descriptor;
  }

  /** Tear down per-trigger resources before a trigger is removed. */
  protected deactivate(descriptor: TriggerDescriptor): void {
    void descriptor;
  }
}

/** Reads the filter string a registered trigger declared under `payload[key]`. */
function triggerFilter(trigger: TriggerDescriptor, key: string): string | undefined {
  const value = trigger.payload?.[key];
  return typeof value === 'string' ? value : undefined;
}

function isObject(value: unknown): value is { readonly [key: string]: unknown } {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isJsonValue(value: unknown, ancestors = new Set<object>()): value is PluginConfigValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || ancestors.has(value)) return false;
  if (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  ancestors.add(value);
  const values: unknown[] = Array.isArray(value) ? Array.from(value) : Object.values(value);
  const valid = values.every(child => isJsonValue(child, ancestors));
  ancestors.delete(value);
  return valid;
}

// --- Webhook (HMAC-verified) ---

export interface WebhookEvent {
  /** Event name, taken from the body's `event` or `type` field. */
  readonly name: string;
  /** Parsed body (or its nested `payload` object). */
  readonly payload: Readonly<{ [key: string]: unknown }>;
}

export type WebhookEventHandler = (event: WebhookEvent, trigger: TriggerDescriptor) => void | Promise<void>;

export interface WebhookTriggerOptions {
  /** Shared secret used to verify `sha256=<hex>` HMAC signatures. */
  readonly secret: string;
  /** Callback invoked for each registered trigger an event matches. */
  readonly onEvent?: WebhookEventHandler;
}

function toBuffer(input: string | Uint8Array): Buffer {
  return typeof input === 'string' ? Buffer.from(input, 'utf8') : Buffer.from(input);
}

/** Normalizes `sha256=<hex>` (or bare hex) to comparable lowercase hex, or null. */
function normalizeSignature(signature: string): string | null {
  if (typeof signature !== 'string') return null;
  const value = signature.trim().toLowerCase();
  const hex = value.startsWith('sha256=') ? value.slice('sha256='.length) : value;
  return /^[0-9a-f]{64}$/.test(hex) ? hex : null;
}

/**
 * HMAC-verified webhook trigger.
 *
 * There is no embedded HTTP server: the host reads the request and passes the
 * raw body plus signature to {@link handle}. Signatures are compared with
 * `timingSafeEqual` over the raw body digest; malformed or wrong-length
 * signatures simply fail verification rather than throwing.
 */
export class WebhookTriggerProvider extends BaseTriggerProvider implements TriggerProvider {
  readonly id = 'trigger.webhook';
  readonly capabilities: Readonly<Record<TriggerCapability, boolean>> = {
    schedule: false,
    webhook: true,
    manual: false,
  };
  protected readonly kind = 'webhook';

  private readonly secret: string;
  private readonly onEvent?: WebhookEventHandler;

  constructor(options: WebhookTriggerOptions) {
    super();
    if (typeof options.secret !== 'string' || !options.secret) throw new Error('Webhook secret is required');
    this.secret = options.secret;
    this.onEvent = options.onEvent;
  }

  /** Constant-time HMAC-SHA256 verification over the raw body. */
  verifySignature(rawBody: string | Uint8Array, signature: string): boolean {
    const provided = normalizeSignature(signature);
    if (!provided) return false;
    const expected = createHmac('sha256', this.secret).update(toBuffer(rawBody)).digest('hex');
    const expectedBytes = Buffer.from(expected, 'utf8');
    const providedBytes = Buffer.from(provided, 'utf8');
    if (expectedBytes.length !== providedBytes.length) return false;
    return timingSafeEqual(expectedBytes, providedBytes);
  }

  /**
   * Verifies the signature then dispatches the parsed event to every registered
   * trigger it matches. Throws on a bad signature or unparseable JSON.
   */
  async handle(
    rawBody: string | Uint8Array,
    signature: string,
    options?: ProviderOperationOptions,
  ): Promise<{ readonly dispatched: number }> {
    checkAbort(options);
    if (!this.verifySignature(rawBody, signature)) throw new Error('Invalid webhook signature');
    let parsed: unknown;
    try {
      parsed = JSON.parse(toBuffer(rawBody).toString('utf8'));
    } catch {
      throw new Error('Invalid webhook payload');
    }
    return this.handleAuthenticatedPayload(parsed, options);
  }

  validatePayload(body: unknown): WebhookEvent {
    if (!isObject(body)) throw new Error('Invalid webhook payload: expected an object');
    if ((body.event !== undefined && (typeof body.event !== 'string' || !body.event.trim()))
      || (body.type !== undefined && (typeof body.type !== 'string' || !body.type.trim()))) throw new Error('Invalid webhook event name');
    const name =
      typeof body.event === 'string' ? body.event : typeof body.type === 'string' ? body.type : 'message';
    const payload = body.payload === undefined ? body : body.payload;
    if (!isObject(payload)) throw new Error('Invalid webhook payload: expected an object');
    return { name, payload };
  }

  async handleAuthenticatedPayload(input: unknown, options?: ProviderOperationOptions): Promise<{ readonly dispatched: number }> {
    checkAbort(options);
    const { name, payload } = this.validatePayload(input);
    let dispatched = 0;
    for (const trigger of [...this.registered.values()]) {
      checkAbort(options);
      const filter = triggerFilter(trigger, 'event');
      if (filter !== undefined && filter !== name) continue;
      if (this.onEvent) {
        await this.onEvent({ name, payload }, trigger);
        checkAbort(options);
        dispatched += 1;
      }
    }
    return { dispatched };
  }
}

// --- Git push ---

export interface GitPushPayload {
  readonly ref: string;
  readonly before?: string;
  readonly after?: string;
  readonly created?: boolean;
  readonly deleted?: boolean;
  readonly repository?: { readonly name?: string };
  readonly pusher?: { readonly name?: string; readonly email?: string };
}

export type GitPushHandler = (payload: GitPushPayload, trigger: TriggerDescriptor) => void | Promise<void>;

export interface GitPushTriggerOptions {
  readonly onPush?: GitPushHandler;
  /** When true, branch-deletion pushes are dispatched too (default: filtered). */
  readonly includeDeleted?: boolean;
}

/**
 * Filters push payloads by the branch a trigger subscribed to and (by default)
 * drops branch-deletion pushes before dispatching to the injected callback.
 */
export class GitPushTriggerProvider extends BaseTriggerProvider implements TriggerProvider {
  readonly id = 'trigger.git-push';
  readonly capabilities: Readonly<Record<TriggerCapability, boolean>> = {
    schedule: false,
    webhook: true,
    manual: false,
  };
  protected readonly kind = 'webhook';

  private readonly onPush?: GitPushHandler;
  private readonly includeDeleted: boolean;

  constructor(options: GitPushTriggerOptions = {}) {
    super();
    this.onPush = options.onPush;
    this.includeDeleted = options.includeDeleted ?? false;
  }

  async handlePush(payload: GitPushPayload, options?: ProviderOperationOptions): Promise<{ readonly dispatched: number }> {
    return this.handle(payload, options);
  }

  async handle(input: unknown, options?: ProviderOperationOptions): Promise<{ readonly dispatched: number }> {
    checkAbort(options);
    const payload = this.validatePayload(input);
    if (!this.includeDeleted && payload.deleted) return { dispatched: 0 };
    let dispatched = 0;
    for (const trigger of [...this.registered.values()]) {
      checkAbort(options);
      const branch = triggerFilter(trigger, 'branch');
      if (branch !== undefined) {
        const ref = `refs/heads/${branch}`;
        if (payload.ref !== ref && payload.ref !== branch) continue;
      }
      if (this.onPush) {
        await this.onPush(payload, trigger);
        checkAbort(options);
        dispatched += 1;
      }
    }
    return { dispatched };
  }

  validatePayload(input: unknown): GitPushPayload {
    if (!isObject(input) || typeof input.ref !== 'string' || !input.ref.trim()
      || ['before', 'after'].some(key => input[key] !== undefined && typeof input[key] !== 'string')
      || ['created', 'deleted'].some(key => input[key] !== undefined && typeof input[key] !== 'boolean')
      || ['repository', 'pusher'].some(key => input[key] !== undefined && !isObject(input[key]))) throw new Error('Invalid git push payload');
    return input as unknown as GitPushPayload;
  }
}

// --- Issue events ---

export interface IssueEventPayload {
  readonly action: string;
  readonly issue?: {
    readonly number?: number;
    readonly title?: string;
    readonly state?: string;
    readonly labels?: ReadonlyArray<string | { readonly name: string }>;
  };
  readonly repository?: { readonly name?: string };
}

export type IssueEventHandler = (payload: IssueEventPayload, trigger: TriggerDescriptor) => void | Promise<void>;

export interface IssueEventTriggerOptions {
  readonly onIssue?: IssueEventHandler;
}

/**
 * Filters issue-event payloads by the action (and optionally a label) a trigger
 * subscribed to before dispatching to the injected callback.
 */
export class IssueEventTriggerProvider extends BaseTriggerProvider implements TriggerProvider {
  readonly id = 'trigger.issue-event';
  readonly capabilities: Readonly<Record<TriggerCapability, boolean>> = {
    schedule: false,
    webhook: true,
    manual: false,
  };
  protected readonly kind = 'webhook';

  private readonly onIssue?: IssueEventHandler;

  constructor(options: IssueEventTriggerOptions = {}) {
    super();
    this.onIssue = options.onIssue;
  }

  async handleIssue(
    payload: IssueEventPayload,
    options?: ProviderOperationOptions,
  ): Promise<{ readonly dispatched: number }> {
    return this.handle(payload, options);
  }

  async handle(input: unknown, options?: ProviderOperationOptions): Promise<{ readonly dispatched: number }> {
    checkAbort(options);
    const payload = this.validatePayload(input);
    let dispatched = 0;
    for (const trigger of [...this.registered.values()]) {
      checkAbort(options);
      const action = triggerFilter(trigger, 'action');
      if (action !== undefined && action !== payload.action) continue;
      const label = triggerFilter(trigger, 'label');
      if (label !== undefined && !(payload.issue?.labels ?? []).some(candidate => (typeof candidate === 'string' ? candidate : candidate.name) === label)) continue;
      if (this.onIssue) {
        await this.onIssue(payload, trigger);
        checkAbort(options);
        dispatched += 1;
      }
    }
    return { dispatched };
  }

  validatePayload(input: unknown): IssueEventPayload {
    if (!isObject(input) || typeof input.action !== 'string' || !input.action.trim()
      || (input.issue !== undefined && !isObject(input.issue))
      || (input.repository !== undefined && !isObject(input.repository))) throw new Error('Invalid issue event payload');
    if (isObject(input.issue) && input.issue.labels !== undefined
      && (!Array.isArray(input.issue.labels) || input.issue.labels.some(label => typeof label !== 'string' && (!isObject(label) || typeof label.name !== 'string')))) throw new Error('Invalid issue event labels');
    return input as unknown as IssueEventPayload;
  }
}

// --- Schedule ---

/** Injectable `setInterval` returning an opaque timer handle. */
export type ScheduleSetInterval = (callback: () => void, ms: number) => unknown;
/** Injectable `clearInterval` accepting the handle {@link ScheduleSetInterval} returned. */
export type ScheduleClearInterval = (handle: unknown) => void;

export interface ScheduledTriggerTick {
  readonly id: string;
  readonly scheduledAt: number;
}

export interface ScheduleTriggerOptions {
  /** Callback fired on each interval tick. */
  readonly onFire?: (trigger: TriggerDescriptor, tick: ScheduledTriggerTick) => void | Promise<void>;
  readonly onError?: (error: unknown, trigger: TriggerDescriptor) => void | Promise<void>;
  readonly setInterval?: ScheduleSetInterval;
  readonly clearInterval?: ScheduleClearInterval;
}

/**
 * Parses `descriptor.schedule` as integer milliseconds. Returns null for any
 * value that is not a positive, safe integer (empty, non-numeric, zero, negative,
 * fractional).
 */
function parseIntervalMs(schedule: string | undefined): number | null {
  if (typeof schedule !== 'string' || !/^[1-9]\d*$/.test(schedule.trim())) return null;
  const value = Number(schedule.trim());
  if (!Number.isSafeInteger(value) || value > 2_147_483_647) return null;
  return value;
}

/**
 * Interval-based trigger that genuinely arms timers through injectable
 * `setInterval`/`clearInterval`, so tests can advance fake clocks. A timer is
 * cleaned up on `unregister` and on `dispose`.
 */
export class ScheduleTriggerProvider extends BaseTriggerProvider implements TriggerProvider {
  readonly id = 'trigger.schedule';
  readonly capabilities: Readonly<Record<TriggerCapability, boolean>> = {
    schedule: true,
    webhook: false,
    manual: false,
  };
  protected readonly kind = 'schedule';

  private readonly onFire?: ScheduleTriggerOptions['onFire'];
  private readonly onError?: ScheduleTriggerOptions['onError'];
  private failed = false;
  private readonly setIntervalFn: ScheduleSetInterval;
  private readonly clearIntervalFn: ScheduleClearInterval;
  private readonly timers = new Map<string, unknown>();
  private readonly pending = new Set<Promise<void>>();

  constructor(options: ScheduleTriggerOptions = {}) {
    super();
    this.onFire = options.onFire;
    this.onError = options.onError;
    this.setIntervalFn = options.setInterval ?? ((callback, ms) => setInterval(callback, ms));
    this.clearIntervalFn = options.clearInterval ?? (handle => clearInterval(handle as ReturnType<typeof setInterval>));
  }

  /** Handles of currently-armed timers, for diagnostics/tests. */
  get armedTimerIds(): readonly string[] {
    return [...this.timers.keys()];
  }

  async health(): Promise<{ status: 'ok' | 'degraded'; message?: string }> {
    return this.failed ? { status: 'degraded', message: 'Schedule callback failed' } : { status: 'ok' };
  }

  async dispose(options?: ProviderOperationOptions): Promise<void> {
    try { await super.dispose(options); }
    finally { await Promise.allSettled([...this.pending]); }
  }

  protected assertDescriptor(descriptor: TriggerDescriptor): void {
    if (parseIntervalMs(descriptor.schedule) === null) {
      throw new Error(
        `Invalid schedule "${descriptor.schedule ?? ''}": expected a positive integer number of milliseconds`,
      );
    }
  }

  protected activate(descriptor: TriggerDescriptor): void {
    const ms = parseIntervalMs(descriptor.schedule);
    if (ms === null) return; // unreachable: assertDescriptor guards
    const activationId = randomUUID();
    let sequence = 0;
    const handle = this.setIntervalFn(() => {
      const work = this.fire(descriptor, { id: `${activationId}:${++sequence}`, scheduledAt: Date.now() });
      this.pending.add(work);
      void work.finally(() => this.pending.delete(work));
    }, ms);
    this.timers.set(descriptor.id, handle);
  }

  protected deactivate(descriptor: TriggerDescriptor): void {
    const handle = this.timers.get(descriptor.id);
    if (this.timers.has(descriptor.id)) {
      this.clearIntervalFn(handle);
      this.timers.delete(descriptor.id);
    }
  }

  private async fire(descriptor: TriggerDescriptor, tick: ScheduledTriggerTick): Promise<void> {
    if (this.registered.get(descriptor.id) !== descriptor) return;
    try {
      if (this.onFire) await this.onFire(descriptor, tick);
      this.failed = false;
    } catch (error) {
      this.failed = true;
      try { await this.onError?.(error, descriptor); } catch { this.failed = true; }
    }
  }
}
