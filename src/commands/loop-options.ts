import type { Command } from 'commander';
import { InvalidArgumentError } from 'commander';

export interface LoopStartOptions {
  daemon?: boolean;
  maxConcurrent?: number;
  pollInterval?: number;
  statusInterval?: number;
  shutdownTimeout?: number;
  maxIterations?: number;
  ext?: string[];
  extParam?: string[];
}

export const LOOP_START_OPTIONS = [
  ['-d, --daemon', 'Run as background daemon (returns immediately, logs to file)'],
  ['-n, --max-concurrent <n>', 'Max parallel implement chains'],
  ['-p, --poll-interval <seconds>', 'Backlog poll interval'],
  ['-i, --status-interval <seconds>', 'Status file write interval'],
  ['-t, --shutdown-timeout <seconds>', 'Max wait for in-flight on SIGTERM'],
  ['-m, --max-iterations <n>', 'Stop after N successful completions (testing)'],
  ['--ext <modules...>', 'Lifecycle modules to activate (e.g., isolate)'],
  ['--ext-param <params...>', 'Module parameters (e.g., isolate.auto=true)'],
] as const;

export function parsePositiveInt(value: string, _previous: number | undefined): number {
  const numberValue = parseInt(value, 10);
  if (!Number.isInteger(numberValue) || numberValue <= 0) {
    throw new InvalidArgumentError(`expected a positive integer, got '${value}'`);
  }
  return numberValue;
}

export function addLoopStartOptions(command: Command): void {
  for (const [flags, description] of LOOP_START_OPTIONS) {
    if (flags.includes('<')) {
      command.option(flags, description, parsePositiveInt);
    } else {
      command.option(flags, description);
    }
  }
}
