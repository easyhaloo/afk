import { Command, InvalidArgumentError } from 'commander';

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

interface LoopOptionDefinition {
  flags: string;
  description: string;
  numeric?: boolean;
}

export const LOOP_START_OPTIONS: readonly LoopOptionDefinition[] = [
  { flags: '-d, --daemon', description: 'Run as background daemon (returns immediately, logs to file)' },
  { flags: '-n, --max-concurrent <n>', description: 'Max parallel implement chains', numeric: true },
  { flags: '-p, --poll-interval <seconds>', description: 'Backlog poll interval', numeric: true },
  { flags: '-i, --status-interval <seconds>', description: 'Status file write interval', numeric: true },
  { flags: '-t, --shutdown-timeout <seconds>', description: 'Max wait for in-flight on SIGTERM', numeric: true },
  { flags: '-m, --max-iterations <n>', description: 'Stop after N successful completions (testing)', numeric: true },
  { flags: '--ext <modules...>', description: 'Lifecycle modules to activate (e.g., isolate)' },
  { flags: '--ext-param <params...>', description: 'Module parameters (e.g., isolate.auto=true)' },
];

export function parsePositiveInt(value: string, _previous: number | undefined): number {
  const numberValue = parseInt(value, 10);
  if (!Number.isInteger(numberValue) || numberValue <= 0) {
    throw new InvalidArgumentError(`expected a positive integer, got '${value}'`);
  }
  return numberValue;
}

export function addLoopStartOptions(command: Command): void {
  for (const option of LOOP_START_OPTIONS) {
    if (option.numeric) {
      command.option(option.flags, option.description, parsePositiveInt);
    } else {
      command.option(option.flags, option.description);
    }
  }
}
