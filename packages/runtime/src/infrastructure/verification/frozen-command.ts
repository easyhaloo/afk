import { createHash } from 'node:crypto';
import { isAbsolute, resolve, posix } from 'node:path';
import { z } from 'zod';
import type { ProviderOperationOptions, VerificationExecutionObservation } from '../../plugin-sdk/capabilities.js';
import { checkAbort } from '../providers/dependencies.js';
import { captureFrozenInput, replaceFrozenFile } from '../sandbox/container/frozen-input.js';
import { executeFrozenContainer, type FrozenExecutionOwnership } from '../sandbox/container/frozen-execution.js';
import type { ContainerProvider } from '../sandbox/container/types.js';
import { DockerContainerProvider } from '../sandbox/container/docker.js';

const requestFile = '.verification-request.json';
const targetFile = '.verification-target.json';
const text = (limit: number) => z.string().refine(value => Buffer.byteLength(value, 'utf8') <= limit);
export const frozenCheckerConfigurationSchema = z.object({
  checkerRoot: z.string().max(4096).refine(path => isAbsolute(path) && resolve(path) === path && !/[\0\r\n]/.test(path)),
  checkerDigest: z.string().regex(/^[a-f0-9]{64}$/), baseImageId: z.string().regex(/^sha256:[a-f0-9]{64}$/),
}).strict();
const requestSchema = frozenCheckerConfigurationSchema.extend({
  version: z.literal(1), executionId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/),
  command: z.array(z.string().max(4096).refine(argument => !argument.includes('\0'))).min(1).max(64)
    .refine(command => posix.isAbsolute(command[0]) && posix.normalize(command[0]) === command[0]
      && command.includes(`/workspace/${requestFile}`) && command.includes(`/workspace/${targetFile}`)),
  input: text(256 * 1024), target: z.object({ content: text(128 * 1024), digest: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  timeoutMs: z.number().int().positive().max(120000),
}).strict();

export type FrozenVerificationRequest = z.input<typeof requestSchema>;
const nativeObservations = new WeakSet<object>();

export function isNativeFrozenVerificationObservation(value: unknown): value is VerificationExecutionObservation {
  return value !== null && typeof value === 'object' && nativeObservations.has(value);
}

export async function executeNativeFrozenVerification(input: FrozenVerificationRequest,
  options: ProviderOperationOptions & { onOwnership: (ownership: FrozenExecutionOwnership) => void | Promise<void> }): Promise<VerificationExecutionObservation> {
  const onOwnership = options?.onOwnership;
  if (typeof onOwnership !== 'function') throw new Error('frozen_ownership_journal_required');
  const receipt = await executeFrozenVerification(new DockerContainerProvider(), input, { ...options, onOwnership });
  const { binding, result } = receipt;
  const { evidence } = result;
  const observation: VerificationExecutionObservation = Object.freeze({ protocol: 'verification-execution-v1',
    executionId: binding.executionId, command: binding.command, cwd: '/workspace', inputDigest: binding.inputDigest,
    exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr, closed: true,
    frozen: Object.freeze({ checkerDigest: binding.checkerDigest, baseImageId: binding.baseImageId,
      targetDigest: binding.targetDigest, operationId: evidence.operationId, containerId: evidence.containerId,
      imageId: evidence.imageId, inputDigest: evidence.inputDigest, contextDigest: evidence.contextDigest,
      commandDigest: evidence.commandDigest, policyDigest: evidence.policyDigest,
      containerRemoved: result.cleanup.containerRemoved, imageRemoved: result.cleanup.imageRemoved }) });
  nativeObservations.add(observation);
  return observation;
}

export async function executeFrozenVerification(provider: ContainerProvider, input: FrozenVerificationRequest,
  options: ProviderOperationOptions & { onOwnership?: (ownership: FrozenExecutionOwnership) => void | Promise<void> } = {}) {
  checkAbort(options);
  const request = requestSchema.parse(input);
  const deadlineAt = Math.min(options.deadlineAt ?? Infinity, Date.now() + request.timeoutMs);
  const signal = options.signal;
  const onOwnership = options.onOwnership;
  const check = () => checkAbort({ signal, deadlineAt });
  const hash = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
  check();
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  const timer = setTimeout(() => controller.abort(new Error('Frozen verification deadline exceeded')), Math.max(1, deadlineAt - Date.now()));
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  try {
    if (hash(request.target.content) !== request.target.digest) throw new Error('Frozen target digest changed');
    let captured = captureFrozenInput(request.checkerRoot, { signal: controller.signal });
    if (captured.digest !== request.checkerDigest) throw new Error('Frozen checker digest changed');
    if (captured.manifest.some(entry => entry.path === requestFile || entry.path === targetFile)) throw new Error('Frozen checker contains a reserved input path');
    captured = replaceFrozenFile(captured, requestFile, Buffer.from(request.input, 'utf8'));
    captured = replaceFrozenFile(captured, targetFile, Buffer.from(request.target.content, 'utf8'));
    const binding = Object.freeze({ executionId: request.executionId, checkerDigest: request.checkerDigest,
      baseImageId: request.baseImageId, command: Object.freeze([...request.command]),
      inputDigest: hash(request.input), targetDigest: request.target.digest });
    check();
    const result = await executeFrozenContainer(provider, { input: captured, baseImageId: binding.baseImageId,
      argv: binding.command, timeoutMs: Math.max(1, Math.floor(deadlineAt - Date.now())), maxOutputBytes: 32 * 1024,
      signal: controller.signal, onOwnership });
    check();
    if (controller.signal.aborted) throw controller.signal.reason;
    return Object.freeze({ protocol: 'verification-frozen-v1' as const, binding, result });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}
