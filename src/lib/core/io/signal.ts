import { promises as fs, readFileSync } from 'fs';
import { join } from 'path';
import type { Signal } from '../../schemas.js';
import { SignalSchema } from '../../schemas.js';

export type { Signal } from '../../schemas.js';
export { SignalSchema } from '../../schemas.js';
export { getCurrentTimestamp } from '../../schemas.js';

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
    // can catch an empty or partial file mid-write. Return null so the
    // polling loop retries instead of crashing the workflow.
    if (error instanceof SyntaxError) {
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
