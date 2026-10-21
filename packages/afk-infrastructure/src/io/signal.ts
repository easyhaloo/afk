import { promises as fs, readFileSync } from 'fs';
import { join } from 'path';
import { z } from 'zod';
import type { Signal } from '@afk/core';
import { SignalSchema } from '../schemas.js';

export { SignalSchema } from '../schemas.js';
export { getCurrentTimestamp } from '../schemas.js';

export const SIGNAL_FILE = '.afk-signal.json';

/**
 * The signal file is there, and it is not a signal.
 *
 * A file nobody can read is not the same as no file at all. While the two
 * were the same, an agent that wrote a broken signal left the runner
 * waiting for a signal that could never arrive, until the timeout named
 * the wrong reason. This error says what is wrong with the file, so the
 * caller can say that instead of waiting.
 */
export class SignalFileError extends Error {
  readonly code = 'INVALID_SIGNAL_FILE';

  constructor(message: string) {
    super(message);
    this.name = 'SignalFileError';
  }
}

/**
 * The one grammar of the signal file.
 *
 * The writer, the async reader and the sync reader all go through it, so
 * a signal that breaks the grammar is refused on the way in and reported
 * on the way out. There is no third state: a file that is present and
 * readable is a signal, and a file that is present and unreadable is an
 * error.
 */
function parseSignal(content: string, source: string): Signal | null {
  // The writer renames the file into place, so a file that exists and is
  // empty is a writer that has not finished yet - not a broken signal.
  if (!content.trim()) return null;
  let data: unknown;
  try {
    data = JSON.parse(content);
  } catch (error) {
    throw new SignalFileError(`${source} is not valid JSON: ${(error as Error).message}`);
  }
  const parsed = SignalSchema.safeParse(data);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map(issue => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new SignalFileError(`${source} is not a signal: ${problems}`);
  }
  return parsed.data;
}

/**
 * Write a signal to file (atomic operation).
 *
 * The signal is checked against the grammar the readers use before it is
 * written. A signal that breaks the grammar would sit on disk exactly
 * where every reader looks and still be invisible to all of them, so it
 * is refused here, where the mistake is.
 *
 * Used by the `afk signal` commands - which is how an agent writes a
 * completion signal and a handoff-ready signal.
 */
export async function writeSignal(signal: Signal, dir: string = process.cwd()): Promise<void> {
  const parsed = SignalSchema.safeParse(signal);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map(issue => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new SignalFileError(`refusing to write a signal the readers would not accept (${problems})`);
  }
  const signalPath = join(dir, SIGNAL_FILE);
  const content = JSON.stringify(signal, null, 2);
  const tempPath = `${signalPath}.tmp`;
  await fs.writeFile(tempPath, content, 'utf-8');
  await fs.rename(tempPath, signalPath);
}

/**
 * Read and validate signal from file.
 *
 * `null` means there is no signal yet. A file that is there and cannot be
 * read is an error, not an absence.
 */
export async function readSignal(dir: string = process.cwd()): Promise<Signal | null> {
  const signalPath = join(dir, SIGNAL_FILE);
  let content: string;
  try {
    content = await fs.readFile(signalPath, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  return parseSignal(content, signalPath);
}

/**
 * Synchronous read of signal file (used by Control Mode event handler).
 *
 * The same rules as `readSignal`: absent is null, unreadable is an error.
 */
export function readSignalSync(dir: string = process.cwd()): Signal | null {
  const signalPath = join(dir, SIGNAL_FILE);
  let content: string;
  try {
    content = readFileSync(signalPath, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  return parseSignal(content, signalPath);
}

/**
 * Clear signal file.
 */
export async function clearSignal(dir: string = process.cwd()): Promise<void> {
  const signalPath = join(dir, SIGNAL_FILE);
  try {
    await fs.unlink(signalPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}
/**
 * Wait for the signal file to carry a specific type (polling-based).
 *
 * This is the `afk signal wait` command's wait: it watches the file and
 * fails when the signal does not arrive in time.  The runtime waits for a
 * signal through the tmux client instead, which can also see a signal
 * that arrives over Control Mode rather than on disk.
 */
export async function waitForSignal(
  expectedType: Signal['type'],
  options: { timeout?: number; interval?: number; dir?: string } = {},
): Promise<Signal> {
  const { timeout = 300000, interval = 2000, dir = process.cwd() } = options;
  const startTime = Date.now();
  while (Date.now() - startTime < timeout) {
    const signal = await readSignal(dir);
    if (signal && signal.type === expectedType) return signal;
    await new Promise(resolve => setTimeout(resolve, interval));
  }
  throw new Error(`Timeout waiting for signal type: ${expectedType}`);
}
