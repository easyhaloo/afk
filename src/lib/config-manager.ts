import { getGlabToken } from './glab-config.js';

// ─── GitLab ───────────────────────────────────────────────────────────────────

export interface GitLabConfig {
  url: string;
  token: string;
  projectId: string | number;
}

// ─── Workflow ─────────────────────────────────────────────────────────────────

export interface WorkflowConfig {
  /** Max time to wait for /goal completion (ms) */
  completionTimeout: number;
  /** Max idle time before probing agent (ms) */
  idleTimeout: number;
  /** Time to wait for AC check after goal done (ms) */
  acCheckTimeout: number;
  /** Token count threshold to trigger handoff */
  contextThreshold: number;
  /** Max retry attempts before escalating to hitl */
  maxRetries: number;
  /** Default target branch when no base::prd-N label exists */
  targetBranch: string;
  /** Token budget per /goal run */
  goalBudget: number;
}

// ─── Scheduler ────────────────────────────────────────────────────────────────

export interface SchedulerConfig {
  maxConcurrent: number;
  redisHost: string;
  redisPort: number;
  pollInterval: number;
}

// ─── Worktree ─────────────────────────────────────────────────────────────────

export interface WorktreeConfig {
  baseDir: string;
}

// ─── Full Config ──────────────────────────────────────────────────────────────

export interface Config {
  gitlab: GitLabConfig;
  workflow: WorkflowConfig;
  scheduler: SchedulerConfig;
  worktree: WorktreeConfig;
}

// ─── Loader ──────────────────────────────────────────────────────────────────

const DEFAULT_WORKFLOW: WorkflowConfig = {
  completionTimeout: 7200 * 1000,
  idleTimeout: 1800 * 1000,
  acCheckTimeout: 180 * 1000,
  contextThreshold: 220_000,
  maxRetries: 2,
  targetBranch: 'main',
  goalBudget: 10_000_000,
};

const DEFAULT_SCHEDULER: SchedulerConfig = {
  maxConcurrent: 3,
  redisHost: 'localhost',
  redisPort: 6379,
  pollInterval: 60,
};

const DEFAULT_WORKTREE: WorktreeConfig = {
  baseDir: '/tmp/afk-worktrees',
};

function loadGitLabConfig(): GitLabConfig {
  let url = process.env.GITLAB_URL;
  let token = process.env.GITLAB_TOKEN;
  const projectId = process.env.GITLAB_PROJECT_ID;

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
    projectId: projectId || '',
  };
}

function loadWorkflowConfig(): WorkflowConfig {
  return {
    completionTimeout: parseEnvMs('AFK_COMPLETION_TIMEOUT', DEFAULT_WORKFLOW.completionTimeout),
    idleTimeout: parseEnvMs('AFK_IDLE_TIMEOUT', DEFAULT_WORKFLOW.idleTimeout),
    acCheckTimeout: parseEnvMs('AFK_AC_CHECK_TIMEOUT', DEFAULT_WORKFLOW.acCheckTimeout),
    contextThreshold: parseIntEnv('AFK_CONTEXT_THRESHOLD', DEFAULT_WORKFLOW.contextThreshold),
    maxRetries: parseIntEnv('AFK_MAX_RETRIES', DEFAULT_WORKFLOW.maxRetries),
    targetBranch: process.env.AFK_TARGET_BRANCH || DEFAULT_WORKFLOW.targetBranch,
    goalBudget: parseIntEnv('AFK_GOAL_BUDGET', DEFAULT_WORKFLOW.goalBudget),
  };
}

function loadSchedulerConfig(): SchedulerConfig {
  return {
    maxConcurrent: parseIntEnv('AFK_MAX_CONCURRENT', DEFAULT_SCHEDULER.maxConcurrent),
    redisHost: process.env.REDIS_HOST || DEFAULT_SCHEDULER.redisHost,
    redisPort: parseIntEnv('REDIS_PORT', DEFAULT_SCHEDULER.redisPort),
    pollInterval: parseIntEnv('AFK_POLL_INTERVAL', DEFAULT_SCHEDULER.pollInterval),
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
  const ms = parseInt(val, 10);
  // if value is in seconds (no unit), convert
  return ms < 1000 ? ms * 1000 : ms;
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

export function getConfig(): Config {
  return {
    gitlab: getGitLabConfig(),
    workflow: getWorkflowConfig(),
    scheduler: getSchedulerConfig(),
    worktree: getWorktreeConfig(),
  };
}
