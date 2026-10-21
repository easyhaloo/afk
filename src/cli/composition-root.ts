import { queryExecutionHistory } from '@afk/application';
import type {
  AgentTelemetryPort,
  BrowserPort,
  ConfigurationPort,
  LoopProcessPort,
  RunSessionPort,
  TmuxPort,
} from '@afk/application';
import { JsonlEventStore } from '@afk/infrastructure/observability';
import type { ApplicationFacade } from './application/facade.js';

export interface CliApplicationOptions {
  eventStoreRoot?: string;
}

export type CliApplicationFactory = (options: CliApplicationOptions) => ApplicationFacade;

export function createCliApplication(options: CliApplicationOptions = {}): ApplicationFacade {
  const events = new JsonlEventStore({ root: options.eventStoreRoot });
  return {
    queryExecutionHistory: input => queryExecutionHistory(input, events),
  };
}

/**
 * The runtime the CLI drives, reached through its ports.
 *
 * A command is a driver: it turns what the user asked for into a call on
 * a use case. It does not know how the configuration file is read, which
 * class talks to tmux, or where the harness keeps its transcript - those
 * are the runtime's decisions, and the runtime says what it is behind
 * these ports.
 */
export interface CliRuntimePorts {
  configuration: ConfigurationPort;
  tmux: TmuxPort;
  loopProcess: LoopProcessPort;
  agentTelemetry: AgentTelemetryPort;
  browser: BrowserPort;
  runSession: RunSessionPort;
}

/**
 * The ports, wired to the real runtime.
 *
 * This is the one place in the CLI that knows which implementation backs
 * each port. The runtime's modules are loaded here and nowhere else, so a
 * command that reaches for an implementation instead of a port is visible
 * as exactly that: an import in a file that has no business making one.
 */
export async function createCliRuntimePorts(): Promise<CliRuntimePorts> {
  const [configuration, tmux, loopProcess, agentTelemetry, browser, runSession] = await Promise.all([
    import('@afk/execution/infrastructure/config/manager'),
    import('@afk/execution/infrastructure/tmux/tmux-port'),
    import('@afk/execution/infrastructure/process/loop-process-port'),
    import('@afk/execution/infrastructure/observability/agent-telemetry-port'),
    import('@afk/execution/infrastructure/browser/browser-port'),
    import('@afk/execution/infrastructure/runtime/run-session-port'),
  ]);
  return {
    configuration: configuration.fileConfigurationPort,
    tmux: tmux.tmuxPort,
    loopProcess: loopProcess.loopProcessPort,
    agentTelemetry: agentTelemetry.agentTelemetryPort,
    browser: browser.browserPort,
    runSession: runSession.runSessionPort,
  };
}
