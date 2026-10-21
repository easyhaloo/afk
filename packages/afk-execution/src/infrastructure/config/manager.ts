import { AFK_CONFIG_FILE } from '@afk/core';
import { getGlabToken } from '@afk/infrastructure';
import { AGENT_AUTH_CHOICES, AGENT_TRANSPORT_CHOICES } from '@afk/core';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { load as loadYaml } from 'js-yaml';
import type { GitLabConfig, SchedulerConfig, WorkflowConfig } from '../../domain/config/types.js';
export type { GitLabConfig, SchedulerConfig, WorkflowConfig } from '../../domain/config/types.js';

import {
  assertCodexEndpoint,
  DEFAULT_CODEX_CONFIG,
  type CodexAuth,
  type CodexConfig,
  type CodexTransport,
} from '../../domain/agents/codex-runtime.js';

type ConfigObject = { [key: string]: unknown };

// ─── GitLab ───────────────────────────────────────────────────────────────────

// ─── Workflow ─────────────────────────────────────────────────────────────────

// ─── Scheduler ────────────────────────────────────────────────────────────────

// ─── Worktree ─────────────────────────────────────────────────────────────────

// ─── Defaults ─────────────────────────────────────────────────────────────────

export const DEFAULT_WORKFLOW_CONFIG: WorkflowConfig = {
  agentDefault: 'claude-code',
  tmuxSession: 'afk',
  completionTimeout: 7200 * 1000,
  qaTimeout: 30 * 60 * 1000,
  workflowHardTimeout: 7200 * 1000,
  completionPoll: 5,
  idleTimeout: 1800 * 1000,
  acCheckTimeout: 180 * 1000,
  contextThreshold: 100_000,
  promptTimeout: 30_000,
  handoffTimeout: 60_000,
  maxRetries: 2,
  maxSelfIterations: 2,
  maxQaReworkAttempts: 3,
  targetBranch: 'main',
  trackerTargetBranch: 'main',
  goalBudget: 10_000_000,
  agents: {
    codex: {
      ...DEFAULT_CODEX_CONFIG,
      appServer: { ...DEFAULT_CODEX_CONFIG.appServer },
    },
  },
};

const DEFAULT_SCHEDULER: SchedulerConfig = {
  maxConcurrent: 3,
  pollInterval: 60,
  requiredLabels: ['mode::afk', 'stage::ready-for-issues'],
  excludeLabels: ['stage::afk-in-progress', 'stage::qa', 'stage::done', 'mode::hitl'],
  waveNotify: true,
  updateDashboard: true,
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

export function loadWorkflowConfig(
  projectRoot = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): WorkflowConfig {
  const file = readProjectConfig(projectRoot);
  const maxQaReworkAttempts = file.maxQaReworkAttempts
    ?? Number(env.AFK_MAX_QA_REWORK_ATTEMPTS ?? DEFAULT_WORKFLOW_CONFIG.maxQaReworkAttempts);
  if (typeof maxQaReworkAttempts !== 'number' || !Number.isSafeInteger(maxQaReworkAttempts) || maxQaReworkAttempts < 1) {
    throw new Error('maxQaReworkAttempts must be a positive integer');
  }
  return {
    agentDefault: configString(file.agentDefault) ?? env.AFK_AGENT_DEFAULT ?? DEFAULT_WORKFLOW_CONFIG.agentDefault,
    tmuxSession: configString(file.tmuxSession) ?? env.AFK_TMUX_SESSION ?? DEFAULT_WORKFLOW_CONFIG.tmuxSession,
    completionTimeout: configNumber(file.completionTimeout) ?? parseEnvMs('AFK_COMPLETION_TIMEOUT', DEFAULT_WORKFLOW_CONFIG.completionTimeout, env),
    qaTimeout: configNumber(file.qaTimeout) ?? parseEnvMs('AFK_QA_TIMEOUT', DEFAULT_WORKFLOW_CONFIG.qaTimeout!, env),
    workflowHardTimeout: configNumber(file.workflowHardTimeout) ?? parseEnvMs('AFK_WORKFLOW_HARD_TIMEOUT', DEFAULT_WORKFLOW_CONFIG.workflowHardTimeout, env),
    completionPoll: configNumber(file.completionPoll) ?? parseSeconds('AFK_COMPLETION_POLL', DEFAULT_WORKFLOW_CONFIG.completionPoll, env),
    idleTimeout: configNumber(file.idleTimeout) ?? parseEnvMs('AFK_IDLE_TIMEOUT', DEFAULT_WORKFLOW_CONFIG.idleTimeout, env),
    acCheckTimeout: configNumber(file.acCheckTimeout) ?? parseEnvMs('AFK_AC_CHECK_TIMEOUT', DEFAULT_WORKFLOW_CONFIG.acCheckTimeout, env),
    contextThreshold: configNumber(file.contextThreshold) ?? parseIntEnv('AFK_CONTEXT_THRESHOLD', DEFAULT_WORKFLOW_CONFIG.contextThreshold, env),
    promptTimeout: configNumber(file.promptTimeout) ?? parseEnvMs('AFK_PROMPT_TIMEOUT', DEFAULT_WORKFLOW_CONFIG.promptTimeout, env),
    handoffTimeout: configNumber(file.handoffTimeout) ?? parseEnvMs('AFK_HANDOFF_TIMEOUT', DEFAULT_WORKFLOW_CONFIG.handoffTimeout, env),
    maxRetries: configNumber(file.maxRetries) ?? parseIntEnv('AFK_MAX_RETRIES', DEFAULT_WORKFLOW_CONFIG.maxRetries, env),
    maxSelfIterations: configNumber(file.maxSelfIterations) ?? parseIntEnv('AFK_MAX_SELF_ITERATIONS', DEFAULT_WORKFLOW_CONFIG.maxSelfIterations, env),
    maxQaReworkAttempts,
    targetBranch: configString(file.targetBranch) ?? env.AFK_TARGET_BRANCH ?? DEFAULT_WORKFLOW_CONFIG.targetBranch,
    trackerTargetBranch: configString(file.trackerTargetBranch) ?? env.AFK_TRACKER_TARGET_BRANCH ?? DEFAULT_WORKFLOW_CONFIG.trackerTargetBranch,
    goalBudget: configNumber(file.goalBudget) ?? parseIntEnv('AFK_GOAL_BUDGET', DEFAULT_WORKFLOW_CONFIG.goalBudget, env),
    template: configString(file.template),
    agents: { codex: loadCodexConfig(file, env) },
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
function parseEnvMs(key: string, fallback: number, env: NodeJS.ProcessEnv = process.env): number {
  const val = env[key];
  if (!val) return fallback;
  return parseInt(val, 10) || fallback;
}

function parseSeconds(key: string, fallback: number, env: NodeJS.ProcessEnv = process.env): number {
  const val = env[key];
  if (!val) return fallback;
  const n = parseInt(val, 10);
  return (n || fallback) * 1000;
}

function parseIntEnv(key: string, fallback: number, env: NodeJS.ProcessEnv = process.env): number {
  const val = env[key];
  if (!val) return fallback;
  return parseInt(val, 10) || fallback;
}

// ─── Lazy per-domain caches ───────────────────────────────────────────────────

let _gitlab: GitLabConfig | null = null;
let _workflow: WorkflowConfig | null = null;
let _scheduler: SchedulerConfig | null = null;
export function getGitLabConfig(): GitLabConfig {
  return _gitlab ??= loadGitLabConfig();
}

export function getWorkflowConfig(): WorkflowConfig {
  return _workflow ??= loadWorkflowConfig();
}

export function getSchedulerConfig(): SchedulerConfig {
  return _scheduler ??= loadSchedulerConfig();
}
function readProjectConfig(projectRoot: string): ConfigObject {
  const path = join(projectRoot, AFK_CONFIG_FILE);
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, 'utf8');
  // An empty file is no configuration, not a broken one: a file that was
  // created and never filled in should not stop a run.
  if (!raw.trim()) return {};
  const parsed = loadYaml(raw) as unknown;
  if (parsed === undefined || parsed === null) return {};
  if (!isRecord(parsed)) throw new Error('.afk/config.yml must contain a YAML object');
  return parsed;
}

function loadCodexConfig(file: ConfigObject, env: NodeJS.ProcessEnv): CodexConfig {
  const agents = recordValue(file.agents);
  const codex = recordValue(agents.codex);
  const appServer = recordValue(codex.appServer);
  const transport = (configString(codex.transport) ?? env.AFK_CODEX_TRANSPORT ?? DEFAULT_CODEX_CONFIG.transport) as CodexTransport;
  const auth = (configString(codex.auth) ?? env.AFK_CODEX_AUTH ?? DEFAULT_CODEX_CONFIG.auth) as CodexAuth;
  const provider = configString(codex.provider) ?? env.AFK_CODEX_PROVIDER ?? DEFAULT_CODEX_CONFIG.provider;
  const endpoint = configString(appServer.endpoint) ?? env.AFK_CODEX_APP_SERVER;
  const authTokenEnv = configString(appServer.authTokenEnv) ?? env.AFK_CODEX_APP_SERVER_AUTH_ENV;
  const startupTimeoutMs = durationMs(appServer.startupTimeoutMs ?? appServer.startupTimeout)
    ?? durationMs(env.AFK_CODEX_APP_SERVER_STARTUP_TIMEOUT)
    ?? DEFAULT_CODEX_CONFIG.appServer.startupTimeoutMs;

  if (!(AGENT_TRANSPORT_CHOICES as readonly string[]).includes(transport)) throw new Error(`Invalid Codex transport: ${transport}`);
  if (!(AGENT_AUTH_CHOICES as readonly string[]).includes(auth)) throw new Error(`Invalid Codex auth mode: ${auth}`);
  if (endpoint) assertCodexEndpoint(endpoint);

  return {
    transport,
    auth,
    provider,
    ...optionalConfig('profile', configString(codex.profile) ?? env.AFK_CODEX_PROFILE),
    appServer: {
      ...optionalConfig('endpoint', endpoint),
      ...optionalConfig('authTokenEnv', authTokenEnv),
      startupTimeoutMs,
    },
  };
}

function durationMs(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const match = /^(\d+)(ms|s|m)?$/.exec(value.trim());
  if (!match) throw new Error(`Invalid duration: ${value}`);
  const amount = Number(match[1]);
  const factor = match[2] === 'm' ? 60_000 : match[2] === 's' ? 1_000 : 1;
  return amount * factor;
}

function configString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function configNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function recordValue(value: unknown): ConfigObject {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is ConfigObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function optionalConfig<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
  return value === undefined ? {} : { [key]: value } as { [P in K]?: V };
}
