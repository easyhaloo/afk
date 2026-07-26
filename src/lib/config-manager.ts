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
  /** Seconds between /goal completion checks */
  completionPoll: number;
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
  /** Fallback MR target branch for afk-qa/prototype */
  trackerTargetBranch: string;
  /** Token budget per /goal run */
  goalBudget: number;
}

// ─── Scheduler ────────────────────────────────────────────────────────────────

export interface SchedulerConfig {
  maxConcurrent: number;
  redisHost: string;
  redisPort: number;
  pollInterval: number;
  /** Labels required for an issue to be scheduled */
  requiredLabels: string[];
  /** Labels that exclude an issue from scheduling */
  excludeLabels: string[];
  /** Notify on wave completion */
  waveNotify: boolean;
  /** Update PRD dashboard on each scan */
  updateDashboard: boolean;
}

// ─── Worktree ─────────────────────────────────────────────────────────────────

export interface WorktreeConfig {
  baseDir: string;
}

// ─── Fork ─────────────────────────────────────────────────────────────────────

export interface ForkConfig {
  /** Path to middleware-fork-stack checkout (bin/fork) */
  stackDir: string;
  /** Comma-separated services to fork (auto-detected if empty) */
  services: string;
}

// ─── QA ───────────────────────────────────────────────────────────────────────

export interface QAConfig {
  /** Max time for full AC verification run (seconds) */
  timeout: number;
  /** Max time for single AC check (seconds) */
  singleCheckTimeout: number;
  /** Max retries for flaky checks */
  maxRetries: number;
  /** Auto-merge after all AC pass */
  autoMerge: boolean;
  /** Delete source branch after merge */
  deleteSourceBranch: boolean;
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
  completionPoll: 5,
  idleTimeout: 1800 * 1000,
  acCheckTimeout: 180 * 1000,
  contextThreshold: 220_000,
  maxRetries: 2,
  targetBranch: 'main',
  trackerTargetBranch: 'main',
  goalBudget: 10_000_000,
};

const DEFAULT_SCHEDULER: SchedulerConfig = {
  maxConcurrent: 3,
  redisHost: 'localhost',
  redisPort: 6379,
  pollInterval: 60,
  requiredLabels: ['mode::afk', 'stage::ready-for-issues'],
  excludeLabels: ['stage::afk-in-progress', 'stage::qa', 'stage::done', 'mode::hitl'],
  waveNotify: true,
  updateDashboard: true,
};

const DEFAULT_WORKTREE: WorktreeConfig = {
  baseDir: '/tmp/afk-worktrees',
};

const DEFAULT_FORK: ForkConfig = {
  stackDir: '',
  services: '',
};

const DEFAULT_QA: QAConfig = {
  timeout: 900,
  singleCheckTimeout: 120,
  maxRetries: 1,
  autoMerge: true,
  deleteSourceBranch: true,
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
    completionPoll: parseIntEnv('AFK_COMPLETION_POLL', DEFAULT_WORKFLOW.completionPoll),
    idleTimeout: parseEnvMs('AFK_IDLE_TIMEOUT', DEFAULT_WORKFLOW.idleTimeout),
    acCheckTimeout: parseEnvMs('AFK_AC_CHECK_TIMEOUT', DEFAULT_WORKFLOW.acCheckTimeout),
    contextThreshold: parseIntEnv('AFK_CONTEXT_THRESHOLD', DEFAULT_WORKFLOW.contextThreshold),
    maxRetries: parseIntEnv('AFK_MAX_RETRIES', DEFAULT_WORKFLOW.maxRetries),
    targetBranch: process.env.AFK_TARGET_BRANCH || DEFAULT_WORKFLOW.targetBranch,
    trackerTargetBranch: process.env.AFK_TRACKER_TARGET_BRANCH || DEFAULT_WORKFLOW.trackerTargetBranch,
    goalBudget: parseIntEnv('AFK_GOAL_BUDGET', DEFAULT_WORKFLOW.goalBudget),
  };
}

function loadSchedulerConfig(): SchedulerConfig {
  return {
    maxConcurrent: parseIntEnv('AFK_SCHEDULER_MAX_CONCURRENT', DEFAULT_SCHEDULER.maxConcurrent),
    redisHost: process.env.REDIS_HOST || DEFAULT_SCHEDULER.redisHost,
    redisPort: parseIntEnv('REDIS_PORT', DEFAULT_SCHEDULER.redisPort),
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

function loadForkConfig(): ForkConfig {
  return {
    stackDir: process.env.AFK_FORK_STACK_DIR || DEFAULT_FORK.stackDir,
    services: process.env.AFK_DB_FORK_SERVICES || DEFAULT_FORK.services,
  };
}

function loadQAConfig(): QAConfig {
  return {
    timeout: parseIntEnv('AFK_QA_TIMEOUT', DEFAULT_QA.timeout),
    singleCheckTimeout: parseIntEnv('AFK_QA_SINGLE_CHECK_TIMEOUT', DEFAULT_QA.singleCheckTimeout),
    maxRetries: parseIntEnv('AFK_QA_MAX_RETRIES', DEFAULT_QA.maxRetries),
    autoMerge: (process.env.AFK_QA_AUTO_MERGE ?? String(DEFAULT_QA.autoMerge)).toLowerCase() !== 'false',
    deleteSourceBranch: (process.env.AFK_QA_DELETE_SOURCE_BRANCH ?? String(DEFAULT_QA.deleteSourceBranch)).toLowerCase() !== 'false',
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
let _fork: ForkConfig | null = null;
let _qa: QAConfig | null = null;

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

export function getForkConfig(): ForkConfig {
  return _fork ??= loadForkConfig();
}

export function getQAConfig(): QAConfig {
  return _qa ??= loadQAConfig();
}

export function getConfig(): Config {
  return {
    gitlab: getGitLabConfig(),
    workflow: getWorkflowConfig(),
    scheduler: getSchedulerConfig(),
    worktree: getWorktreeConfig(),
  };
}
