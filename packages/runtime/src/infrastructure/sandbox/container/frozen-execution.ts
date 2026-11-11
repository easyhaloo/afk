import { createHash, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { buildFrozenContext, type CapturedFrozenInput } from './frozen-input.js';
import type { ContainerProvider, FrozenCommandOptions, FrozenContainerInspection } from './types.js';

export interface FrozenExecutionOptions {
  readonly input: CapturedFrozenInput;
  readonly baseImageId: string;
  readonly argv: readonly string[];
  readonly timeoutMs: number;
  readonly maxOutputBytes?: number;
  readonly signal?: AbortSignal;
  readonly onOwnership?: (ownership: FrozenExecutionOwnership) => void | Promise<void>;
}

export interface FrozenExecutionOwnership {
  readonly operationId: string;
  readonly engine: 'docker';
  readonly containerName: string;
  readonly baseImageId: string;
  readonly inputDigest: string;
  readonly contextDigest: string;
}

export class FrozenCleanupError extends AggregateError {
  constructor(readonly ownership: FrozenExecutionOwnership, errors: readonly unknown[], cause: unknown) {
    super(errors, 'Frozen execution cleanup could not be confirmed', { cause });
  }
}

export interface FrozenExecutionResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly evidence: {
    readonly operationId: string;
    readonly containerId: string;
    readonly baseImageId: string;
    readonly imageId: string;
    readonly inputDigest: string;
    readonly contextDigest: string;
    readonly commandDigest: string;
    readonly policyDigest: string;
    readonly mechanism: 'docker-frozen-image';
    readonly argv: readonly string[];
    readonly cwd: '/workspace';
    readonly durationMs: number;
    readonly policy: FrozenContainerInspection;
  };
  readonly cleanup: { readonly containerRemoved: true; readonly imageRemoved: true };
}

function assertPolicy(inspected: FrozenContainerInspection, operationId: string, containerId: string, imageId: string, argv: readonly string[]): void {
  if (inspected.id !== containerId || inspected.operationId !== operationId || inspected.imageId !== imageId
    || inspected.name !== `afk-frozen-${operationId}` || inspected.user !== '1000:1000' || !inspected.readOnlyRoot
    || inspected.network !== 'none' || inspected.privileged || inspected.pidMode !== '' || inspected.ipcMode !== 'private'
    || inspected.binds.length || inspected.mounts.some(mount => mount.type !== 'tmpfs' || mount.destination !== '/scratch')
    || JSON.stringify(inspected.capDrop) !== '["ALL"]' || JSON.stringify(inspected.securityOptions) !== '["no-new-privileges"]'
    || inspected.memory !== 268435456 || inspected.memorySwap !== 268435456 || inspected.nanoCpus !== 1_000_000_000 || inspected.pidsLimit !== 64
    || inspected.workdir !== '/workspace' || JSON.stringify(inspected.entrypoint) !== '["/usr/bin/env"]'
    || JSON.stringify(inspected.command) !== JSON.stringify(['-i', 'PATH=/usr/local/bin:/usr/bin:/bin', 'HOME=/scratch', 'TMPDIR=/scratch', ...argv])
    || Object.keys(inspected.tmpfs).length !== 1 || inspected.tmpfs['/scratch'] !== 'rw,noexec,nosuid,nodev,size=16777216,mode=700,uid=1000,gid=1000') {
    throw new Error('Frozen container policy or execution identity differs from requested isolation');
  }
}

export async function executeFrozenContainer(provider: ContainerProvider, options: FrozenExecutionOptions): Promise<FrozenExecutionResult> {
  options = { ...options, argv: Object.freeze([...options.argv]) };
  const checkAbort = () => { if (options.signal?.aborted) throw options.signal.reason; };
  checkAbort();
  if (provider.engine !== 'docker' || !provider.frozen) throw new Error('Provider has no supported frozen execution capability');
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 120_000
    || !options.argv.length || !options.argv[0]?.trim() || options.argv.length > 128 || options.argv.some(argument => typeof argument !== 'string' || argument.includes('\0'))
    || Buffer.byteLength(JSON.stringify(options.argv)) > 32 * 1024) throw new Error('Invalid frozen execution limits or command');
  const maxOutputBytes = options.maxOutputBytes ?? 64 * 1024;
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1 || maxOutputBytes > 1024 * 1024) throw new Error('Invalid frozen output limit');
  const operationId = randomUUID();
  const context = buildFrozenContext(options.input, options.baseImageId, operationId);
  const ownership = Object.freeze({ operationId, engine: 'docker' as const, containerName: `afk-frozen-${operationId}`,
    baseImageId: options.baseImageId, inputDigest: options.input.digest, contextDigest: context.digest });
  const engine = provider.frozen;
  const administration: FrozenCommandOptions = { timeoutMs: 30_000, maxOutputBytes: 256 * 1024 };
  const started = performance.now();
  let value: FrozenExecutionResult | undefined;
  let failure: unknown;
  let failed = false;
  let allocationUnconfirmed = false;
  try {
    await options.onOwnership?.(ownership);
    checkAbort();
    allocationUnconfirmed = true;
    const imageId = await engine.buildFrozenImage(operationId, options.baseImageId, context.archive, administration);
    allocationUnconfirmed = false;
    checkAbort();
    const argv = Object.freeze([...options.argv]);
    allocationUnconfirmed = true;
    const containerId = await engine.createFrozenContainer(operationId, imageId, argv, administration);
    allocationUnconfirmed = false;
    checkAbort();
    const inspected = await engine.inspectFrozenContainer(containerId, administration);
    assertPolicy(inspected, operationId, containerId, imageId, argv);
    if (inspected.status !== 'created') throw new Error('Frozen container ran before policy verification');
    checkAbort();
    const result = await engine.startFrozenContainer(containerId, { timeoutMs: options.timeoutMs, maxOutputBytes, signal: options.signal });
    checkAbort();
    const completed = await engine.inspectFrozenContainer(containerId, administration);
    assertPolicy(completed, operationId, containerId, imageId, argv);
    if (completed.status !== 'exited' || completed.exitCode !== result.code) throw new Error('Frozen execution exit was not confirmed');
    const digest = (input: unknown) => createHash('sha256').update(JSON.stringify(input)).digest('hex');
    const { status: _status, exitCode: _exitCode, ...policy } = inspected;
    value = { exitCode: completed.exitCode, stdout: result.stdout, stderr: result.stderr,
      evidence: { operationId, containerId, baseImageId: options.baseImageId, imageId, inputDigest: options.input.digest,
        contextDigest: context.digest, commandDigest: digest({ argv: [...inspected.entrypoint, ...inspected.command], cwd: '/workspace' }),
        policyDigest: digest(policy), mechanism: 'docker-frozen-image', argv: [...inspected.entrypoint, ...inspected.command],
        cwd: '/workspace', durationMs: performance.now() - started, policy: inspected }, cleanup: { containerRemoved: true, imageRemoved: true } };
  } catch (error) { failure = error; failed = true; }
  let cleanupFailure: unknown;
  let cleanupFailed = false;
  try {
    await engine.cleanupFrozenOperation(operationId, { ...administration, timeoutMs: 15_000 });
  } catch (error) { cleanupFailure = error; cleanupFailed = true; }
  if (cleanupFailed || allocationUnconfirmed) {
    const hasCause = failed || options.signal?.aborted === true;
    const cause = failed ? failure : options.signal?.aborted ? options.signal.reason : undefined;
    const errors = hasCause ? [cause] : [];
    if (cleanupFailed) errors.push(cleanupFailure);
    if (allocationUnconfirmed) errors.push(new Error('Frozen allocation completion is unconfirmed despite current cleanup inventory'));
    throw new FrozenCleanupError(ownership, errors, cause);
  }
  if (failed) throw failure;
  checkAbort();
  if (!value) throw new Error('Frozen execution produced no result');
  return value;
}
