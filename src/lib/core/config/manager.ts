import { getGlabToken } from '../gitlab/glab-config';

// ─── GitLab ───────────────────────────────────────────────────────────────────

export interface GitLabConfig {
  url: string;
  token: string;
}

// ─── Workflow ─────────────────────────────────────────────────────────────────

export interface WorkflowConfig {
  agentDefault: string;
  tmuxSession: string;
  completionTimeout: number;
  workflowHardTimeout: number;
  completionPoll: number;
  idleTimeout: number;
  acCheckTimeout: number;
  contextThreshold: number;
  promptTimeout: number;
  handoffTimeout: number;
  maxRetries: number;
  maxSelfIterations: number;
  targetBranch: string;
  trackerTargetBranch: string;
  goalBudget: number;
}

// ─── Scheduler ────────────────────────────────────────────────────────────────

export interface SchedulerConfig {
  maxConcurrent: number;
  pollInterval: number;
  requiredLabels: string[];
  excludeLabels: string[];
  waveNotify: boolean;
  updateDashboard: boolean;
}

// ─── Worktree ─────────────────────────────────────────────────────────────────

export interface WorktreeConfig {
  baseDir: string;
}

// ─── Defaults ─────────────────────────────────────────────────────────────────

const DEFAULT_WORKFLOW: WorkflowConfig = {
  agentDefault: 'claude',
  tmuxSession: 'afk',
  completionTimeout: 7200 * 1000,
  workflowHardTimeout: 7200 * 1000,
  completionPoll: 5,
  idleTimeout: 1800 * 1000,
  acCheckTimeout: 180 * 1000,
  contextThreshold: 100_000,
  promptTimeout: 30_000,
  handoffTimeout: 60_000,
  maxRetries: 2,
  maxSelfIterations: 2,
  targetBranch: 'main',
  trackerTargetBranch: 'main',
  goalBudget: 10_000_000,
};

const DEFAULT_SCHEDULER: SchedulerConfig = {
  maxConcurrent: 3,
  pollInterval: 60,
  requiredLabels: ['mode::afk', 'stage::ready-for-issues'],
  excludeLabels: ['stage::afk-in-progress', 'stage::qa', 'stage::done', 'mode::hitl'],
  waveNotify: true,
  updateDashboard: true,
};

const DEFAULT_WORKTREE: WorktreeConfig = {
  baseDir: '/tmp/afk-worktrees',
};

// ─── Loaders ──────────────────────────────────────────────────────────────────

function loadGitLabConfig(): GitLabConfig {
  let url = process.env.GITLAB_URL;
  let token = process.env.GITLAB_TOKEN;

  if (!token) {
    const glab = getGlabToken(url);
    if (glab) {
      url = url || (glab.apiHost.startsWith('http') ? glab.apiHost : `https://${glab.apiHost}`);
      token = glab.token;
    }
  }

  return {
    url: url || 'https://gitlab.com',
    token: token || '',
  };
}

function loadWorkflowConfig(): WorkflowConfig {
  return {
    agentDefault: process.env.AFK_AGENT_DEFAULT || DEFAULT_WORKFLOW.agentDefault,
    tmuxSession: process.env.AFK_TMUX_SESSION || DEFAULT_WORKFLOW.tmuxSession,
    completionTimeout: parseEnvMs('AFK_COMPLETION_TIMEOUT', DEFAULT_WORKFLOW.completionTimeout),
    workflowHardTimeout: parseEnvMs('AFK_WORKFLOW_HARD_TIMEOUT', DEFAULT_WORKFLOW.workflowHardTimeout),
    completionPoll: parseSeconds('AFK_COMPLETION_POLL', DEFAULT_WORKFLOW.completionPoll),
    idleTimeout: parseEnvMs('AFK_IDLE_TIMEOUT', DEFAULT_WORKFLOW.idleTimeout),
    acCheckTimeout: parseEnvMs('AFK_AC_CHECK_TIMEOUT', DEFAULT_WORKFLOW.acCheckTimeout),
    contextThreshold: parseIntEnv('AFK_CONTEXT_THRESHOLD', DEFAULT_WORKFLOW.contextThreshold),
    promptTimeout: parseEnvMs('AFK_PROMPT_TIMEOUT', DEFAULT_WORKFLOW.promptTimeout),
    handoffTimeout: parseEnvMs('AFK_HANDOFF_TIMEOUT', DEFAULT_WORKFLOW.handoffTimeout),
    maxRetries: parseIntEnv('AFK_MAX_RETRIES', DEFAULT_WORKFLOW.maxRetries),
    maxSelfIterations: parseIntEnv('AFK_MAX_SELF_ITERATIONS', DEFAULT_WORKFLOW.maxSelfIterations),
    targetBranch: process.env.AFK_TARGET_BRANCH || DEFAULT_WORKFLOW.targetBranch,
    trackerTargetBranch: process.env.AFK_TRACKER_TARGET_BRANCH || DEFAULT_WORKFLOW.trackerTargetBranch,
    goalBudget: parseIntEnv('AFK_GOAL_BUDGET', DEFAULT_WORKFLOW.goalBudget),
  };
}

function loadSchedulerConfig(): SchedulerConfig {
  return {
    maxConcurrent: parseIntEnv('AFK_SCHEDULER_MAX_CONCURRENT', DEFAULT_SCHEDULER.maxConcurrent),
    pollInterval: parseIntEnv('AFK_SCHEDULER_POLL_INTERVAL', DEFAULT_SCHEDULER.pollInterval),
    requiredLabels: (process.env.AFK_SCHEDULER_REQUIRED_LABELS || DEFAULT_SCHEDULER.requiredLabels.join(',')).split(',').filter(Boolean),
    excludeLabels: (process.env.AFK_SCHEDULER_EXCLUDE_LABELS || DEFAULT_SCHEDULER.excludeLabels.join(',')).split(',').filter(Boolean),
    waveNotify: (process.env.AFK_SCHEDULER_WAVE_NOTIFY ?? String(DEFAULT_SCHEDULER.waveNotify)).toLowerCase() !== 'false',
    updateDashboard: (process.env.AFK_SCHEDULER_UPDATE_DASHBOARD ?? String(DEFAULT_SCHEDULER.updateDashboard)).toLowerCase() !== 'false',
  };
}

function loadWorktreeConfig(): WorktreeConfig {
  return {
    baseDir: process.env.AFK_WORKTREE_DIR || DEFAULT_WORKTREE.baseDir,
  };
}

function parseEnvMs(key: string, fallback: number): number {
  const val = process.env[key];
  if (!val) return fallback;
  return parseInt(val, 10) || fallback;
}

function parseSeconds(key: string, fallback: number): number {
  const val = process.env[key];
  if (!val) return fallback;
  const n = parseInt(val, 10);
  return (n || fallback) * 1000;
}

function parseIntEnv(key: string, fallback: number): number {
  const val = process.env[key];
  if (!val) return fallback;
  return parseInt(val, 10) || fallback;
}

// ─── Lazy per-domain caches ───────────────────────────────────────────────────

let _gitlab: GitLabConfig | null = null;
let _workflow: WorkflowConfig | null = null;
let _scheduler: SchedulerConfig | null = null;
let _worktree: WorktreeConfig | null = null;

export function getGitLabConfig(): GitLabConfig {
  return _gitlab ??= loadGitLabConfig();
}

export function getWorkflowConfig(): WorkflowConfig {
  return _workflow ??= loadWorkflowConfig();
}

export function getSchedulerConfig(): SchedulerConfig {
  return _scheduler ??= loadSchedulerConfig();
}

export function getWorktreeConfig(): WorktreeConfig {
  return _worktree ??= loadWorktreeConfig();
}
