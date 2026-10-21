/**
 * The shapes the runner's configuration takes.
 *
 * The shapes live in the application package: the CLI, the desktop client
 * and the runtime all read the same configuration, and the port that
 * reads it is declared there. This module names them for the runtime.
 */
export type {
  CodexConfig,
  ConfigurationPort,
  GitLabConfig,
  SchedulerConfig,
  WorkflowConfig,
} from '@afk/application';
