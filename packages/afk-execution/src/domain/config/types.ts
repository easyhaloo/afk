/**
 * The shapes the runner's configuration takes.
 *
 * A config is a value: what the workflow reads, how long it waits, which
 * agent it starts.  Reading the file that holds one is the infrastructure
 * layer's job; knowing what the values look like is not, so the shapes live
 * here and the reader imports them.
 */

import type { CodexConfig } from '../../domain/agents/codex-runtime.js';

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

export interface WorktreeConfig {
  baseDir: string;
}
