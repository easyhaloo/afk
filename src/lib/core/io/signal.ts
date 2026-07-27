import { promises as fs } from 'fs';
import { join } from 'path';
import { Signal, SignalSchema } from '../../schemas';

export { Signal, SignalSchema } from '../../schemas';
export { getCurrentTimestamp } from '../../schemas';

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
    const data = JSON.parse(content);
    return SignalSchema.parse(data);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
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
