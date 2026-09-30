import { Command, InvalidArgumentError } from 'commander';

export interface LoopStartOptions {
  daemon?: boolean;
  pollInterval?: number;
  statusInterval?: number;
  shutdownTimeout?: number;
  maxIterations?: number;
  backlogId?: string[];
  template?: string;
  workItemId?: string;
  executionManifest?: string;
}

interface LoopOptionDefinition {
  flags: string;
  description: string;
  numeric?: boolean;
  repeatable?: boolean;
}

export const LOOP_START_OPTIONS: readonly LoopOptionDefinition[] = [
  { flags: '-d, --daemon', description: 'Run as background daemon (returns immediately, logs to file)' },
  { flags: '-p, --poll-interval <seconds>', description: 'Backlog poll interval', numeric: true },
  { flags: '-i, --status-interval <seconds>', description: 'Status file write interval', numeric: true },
  { flags: '-t, --shutdown-timeout <seconds>', description: 'Max wait for in-flight on SIGTERM', numeric: true },
  { flags: '-m, --max-iterations <n>', description: 'Stop after N successful completions (testing)', numeric: true },
  { flags: '--backlog-id <id>', description: 'The one backlog ID bound to the execution manifest', repeatable: true },
  { flags: '--template <name>', description: 'Workflow template name' },
  { flags: '--work-item-id <id>', description: 'Canonical work item ID for a single managed backlog scope' },
  { flags: '--execution-manifest <path>', description: 'Execution manifest for that managed work item' },
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
    } else if (option.repeatable) {
      command.option(option.flags, option.description, (value: string, previous: string[] = []) => [...previous, value], []);
    } else {
      command.option(option.flags, option.description);
    }
  }
}
