import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import {
  INTERRUPT_REQUEST_FILE,
  type InterruptRequest,
  type InterruptRequestReason,
} from '../../domain/runtime/interrupt.js';

/**
 * The interrupt request, on disk.
 *
 * The file is the channel between whoever stops a run and the run
 * itself. It is written before the session is killed, so a runtime that
 * finds its session gone can still say why.
 */

export function interruptRequestPath(worktreePath: string): string {
  return join(worktreePath, INTERRUPT_REQUEST_FILE);
}

/** Write the request. The runtime reads it on its next poll. */
export async function writeInterruptRequest(
  worktreePath: string,
  reason: InterruptRequestReason = 'manual',
): Promise<InterruptRequest> {
  const request: InterruptRequest = { reason, requestedAt: new Date().toISOString() };
  const path = interruptRequestPath(worktreePath);
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(temporary, JSON.stringify(request, null, 2), 'utf8');
  await fs.rename(temporary, path);
  return request;
}

/**
 * The request, when there is one.
 *
 * A file that is there and cannot be read is not a request: the caller
 * cannot act on it, and treating it as one would stop a run for a reason
 * nobody can name.
 */
export async function readInterruptRequest(worktreePath: string): Promise<InterruptRequest | undefined> {
  const raw = await fs.readFile(interruptRequestPath(worktreePath), 'utf8').catch(() => '');
  if (!raw.trim()) return undefined;
  try {
    const value = JSON.parse(raw) as Partial<InterruptRequest>;
    if (value.reason !== 'manual') return undefined;
    return { reason: 'manual', requestedAt: typeof value.requestedAt === 'string' ? value.requestedAt : '' };
  } catch {
    return undefined;
  }
}

/** Forget the request. A run that starts does not inherit the last one's. */
export async function clearInterruptRequest(worktreePath: string): Promise<void> {
  await fs.unlink(interruptRequestPath(worktreePath)).catch(() => undefined);
}
