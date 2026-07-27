import { getGlabToken } from '../gitlab/glab-config';
import { PORTS } from '../../constants';

// ─── GitLab ───────────────────────────────────────────────────────────────────

export interface GitLabConfig {
  url: string;
  token: string;
  projectId: string | number;
}

// ─── Workflow ─────────────────────────────────────────────────────────────────

export interface WorkflowConfig {
  agentDefault: string;
  tmuxSession: string;
  completionTimeout: number;
  completionPoll: number;
  idleTimeout: number;
  acCheckTimeout: number;
  contextThreshold: number;
  maxRetries: number;
  targetBranch: string;
  trackerTargetBranch: string;
  goalBudget: number;
}

// ─── Scheduler ────────────────────────────────────────────────────────────────

export interface SchedulerConfig {
  maxConcurrent: number;
  redisHost: string;
  redisPort: number;
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

// ─── Pipeline ─────────────────────────────────────────────────────────────────

export interface PipelineConfig {
  logRetentionDays: number;
}

// ─── Fork ─────────────────────────────────────────────────────────────────────

export interface ForkConfig {
  stackDir: string;
  services: string;
}

// ─── QA ───────────────────────────────────────────────────────────────────────

export interface QAConfig {
  timeout: number;
  singleCheckTimeout: number;
  maxRetries: number;
  autoMerge: boolean;
  deleteSourceBranch: boolean;
}

// ─── Defaults ─────────────────────────────────────────────────────────────────

const DEFAULT_WORKFLOW: WorkflowConfig = {
  agentDefault: 'claude',
  tmuxSession: 'afk',
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
  redisPort: PORTS.REDIS_DEFAULT,
  pollInterval: 60,
  requiredLabels: ['mode::afk', 'stage::ready-for-issues'],
  excludeLabels: ['stage::afk-in-progress', 'stage::qa', 'stage::done', 'mode::hitl'],
  waveNotify: true,
  updateDashboard: true,
};

const DEFAULT_WORKTREE: WorktreeConfig = {
  baseDir: '/tmp/afk-worktrees',
};

const DEFAULT_PIPELINE: PipelineConfig = {
  logRetentionDays: 7,
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

// ─── Loaders ──────────────────────────────────────────────────────────────────

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
    agentDefault: process.env.AFK_AGENT_DEFAULT || DEFAULT_WORKFLOW.agentDefault,
    tmuxSession: process.env.AFK_TMUX_SESSION || DEFAULT_WORKFLOW.tmuxSession,
    completionTimeout: parseEnvMs('AFK_COMPLETION_TIMEOUT', DEFAULT_WORKFLOW.completionTimeout),
    completionPoll: parseSeconds('AFK_COMPLETION_POLL', DEFAULT_WORKFLOW.completionPoll),
    idleTimeout: parseEnvMs('AFK_IDLE_TIMEOUT', DEFAULT_WORKFLOW.idleTimeout),
    acCheckTimeout: parseEnvMs('AFK_AC_CHECK_TIMEOUT', DEFAULT_WORKFLOW.acCheckTimeout),
    contextThreshold: parseIntEnv('AFK_CONTEXT_THRESHOLD', DEFAULT_WORKFLOW.contextThreshold),
    maxRetries: parseIntEnv('AFK_MAX_RETRIES', DEFAULT_WORKFLOW.maxRetries),
    targetBranch: process.env.AFK_TARGET_BRANCH || DEFAULT_WORKFLOW.targetBranch,
    trackerTargetBranch: process.env.AFK_TRACKER_TARGET_BRANCH || DEFAULT_WORKFLOW.trackerTargetBranch,
    goalBudget: parseIntEnv('AFK_GOAL_BUDGET', DEFAULT_WORKFLOW.goalBudget),
  };
}

function loadPipelineConfig(): PipelineConfig {
  return {
    logRetentionDays: parseIntEnv('AFK_LOG_RETENTION_DAYS', DEFAULT_PIPELINE.logRetentionDays),
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
let _pipeline: PipelineConfig | null = null;
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

export function getPipelineConfig(): PipelineConfig {
  return _pipeline ??= loadPipelineConfig();
}

export function getForkConfig(): ForkConfig {
  return _fork ??= loadForkConfig();
}

export function getQAConfig(): QAConfig {
  return _qa ??= loadQAConfig();
}
