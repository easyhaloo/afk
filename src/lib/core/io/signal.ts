import { promises as fs, readFileSync } from 'fs';
import { join } from 'path';
import { z } from 'zod';
import type { Signal } from '../../schemas.js';
import { SignalSchema } from '../../schemas.js';

export type { Signal } from '../../schemas.js';
export { SignalSchema } from '../../schemas.js';
export { getCurrentTimestamp } from '../../schemas.js';

/**
 * @deprecated Phase 8 (EXECUTION-DESIGN.md §12 阶段 8): `.afk-signal.json`
 * is the LEGACY completion protocol. New agents report via ExecutionResult
 * (see sandbox/types.ts); old worktrees that already contain the file are
 * still read for backward compatibility.
 *
 * Do NOT instruct new agents to write this file in their prompts — see the
 * `issue-implementation` builtin template for the correct (signal-free)
 * prompts. The functions below are kept ONLY so that worktrees started
 * before Phase 8 can still be resumed / inspected. They will be removed
 * in a future major version once all in-flight worktrees have completed.
 */
export const SIGNAL_FILE = '.afk-signal.json';

/**
 * Write a signal to file (atomic operation)
 */
export async function writeSignal(signal: Signal, dir: string = process.cwd()): Promise<void> {
  const signalPath = join(dir, SIGNAL_FILE);
  const content = JSON.stringify(signal, null, 2);

  // Atomic write: write to temp file, then rename
  const tempPath = `${signalPath}.tmp`;
  await fs.writeFile(tempPath, content, 'utf-8');
  await fs.rename(tempPath, signalPath);
}

/**
 * Read and validate signal from file
 */
export async function readSignal(dir: string = process.cwd()): Promise<Signal | null> {
  const signalPath = join(dir, SIGNAL_FILE);

  try {
    const content = await fs.readFile(signalPath, 'utf-8');
    if (!content.trim()) return null;
    const data = JSON.parse(content);
    return SignalSchema.parse(data);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    // Tolerate transient parse errors: the agent writes the signal file
    // non-atomically (heredoc / Write tool truncates then writes), so a poll
    // can catch an empty or partial file mid-write. A schema-invalid payload
    // (ZodError) is equally a "no signal" — the protocol file is internal,
    // polling must never crash the workflow over it.
    if (error instanceof SyntaxError || error instanceof z.ZodError) {
      return null;
    }
    throw error;
  }
}

/**
 * Synchronous read of signal file (used by Control Mode event handler).
 */
export function readSignalSync(dir: string = process.cwd()): Signal | null {
  const signalPath = join(dir, SIGNAL_FILE);
  try {
    const content = readFileSync(signalPath, 'utf-8');
    if (!content.trim()) return null;
    return SignalSchema.parse(JSON.parse(content));
  } catch {
    return null;
  }
}

/**
 * Clear signal file
 */
export async function clearSignal(dir: string = process.cwd()): Promise<void> {
  const signalPath = join(dir, SIGNAL_FILE);

  try {
    await fs.unlink(signalPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
}

/**
 * Watch for signal file changes (polling-based)
 */
export async function waitForSignal(
  expectedType: Signal['type'],
  options: {
    timeout?: number;
    interval?: number;
    dir?: string;
  } = {}
): Promise<Signal> {
  const { timeout = 300000, interval = 2000, dir = process.cwd() } = options;
  const startTime = Date.now();

  while (Date.now() - startTime < timeout) {
    const signal = await readSignal(dir);

    if (signal && signal.type === expectedType) {
      return signal;
    }

    await new Promise(resolve => setTimeout(resolve, interval));
  }

  throw new Error(`Timeout waiting for signal type: ${expectedType}`);
}
