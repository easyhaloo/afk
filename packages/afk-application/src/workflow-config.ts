/**
 * The configuration a run is shaped by.
 *
 * A config is a value: what the workflow reads, how long it waits, which
 * agent it starts. The file that holds one is read by the infrastructure
 * layer; knowing what the values look like is not, so the shapes live
 * here and the reader imports them.
 *
 * The shapes live in the application package because the CLI, the desktop
 * client and the execution runtime all read the same configuration, and
 * the port that reads it is declared there.
 */

/** The codex settings a run uses. */
export interface CodexConfig {
  transport: 'auto' | 'exec' | 'app-server';
  auth: 'auto' | 'chatgpt' | 'api';
  provider: string;
  profile?: string;
  appServer: {
    endpoint?: string;
    authTokenEnv?: string;
    startupTimeoutMs: number;
  };
}

export interface GitLabConfig {
  url: string;
  token: string;
}

export interface WorkflowConfig {
  agentDefault: string;
  tmuxSession: string;
  completionTimeout: number;
  qaTimeout?: number;
  workflowHardTimeout: number;
  completionPoll: number;
  idleTimeout: number;
  acCheckTimeout: number;
  contextThreshold: number;
  promptTimeout: number;
  handoffTimeout: number;
  maxRetries: number;
  maxSelfIterations: number;
  maxQaReworkAttempts: number;
  targetBranch: string;
  trackerTargetBranch: string;
  goalBudget: number;
  /** Optional named AFK workflow template selected for executions. */
  template?: string;
  agents: {
    codex: CodexConfig;
  };
}

export interface SchedulerConfig {
  maxConcurrent: number;
  pollInterval: number;
  requiredLabels: string[];
  excludeLabels: string[];
  waveNotify: boolean;
  updateDashboard: boolean;
}

/**
 * The configuration a run is shaped by.
 *
 * The reader of the configuration file is infrastructure; the callers
 * that shape a run by it are not, and they reach it through this port
 * rather than through the file reader.
 */
export interface ConfigurationPort {
  /** The workflow configuration in effect for a project root. */
  workflow(projectRoot: string): WorkflowConfig;
  /** The defaults, before any file or environment is read. */
  defaults(): WorkflowConfig;
  /** The scheduler configuration. */
  scheduler(): SchedulerConfig;
  /** The GitLab connection. */
  gitLab(): GitLabConfig;
}
