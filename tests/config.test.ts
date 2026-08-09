/**
 * WorkflowConfig and SchedulerConfig loading.
 *
 * Covers environment-variable-driven defaults for all values that were
 * previously hardcoded in source or in constants.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getWorkflowConfig, getSchedulerConfig } from '../src/lib/core/config/manager';

describe('WorkflowConfig env var loading', () => {
  const ORIGINAL = process.env;

  beforeEach(() => {
    process.env = { ...ORIGINAL };
    // Clear the module-level caches so each test gets fresh config
    vi.resetModules();
  });

  afterEach(() => {
    process.env = ORIGINAL;
  });

  async function freshConfig() {
    const { getWorkflowConfig: get } = await import('../src/lib/core/config/manager');
    return get();
  }

  it('defaults when no env vars set', async () => {
    const cfg = await freshConfig();
    expect(cfg.agentDefault).toBe('claude-code');
    expect(cfg.tmuxSession).toBe('afk');
    expect(cfg.workflowHardTimeout).toBe(7200 * 1000);
    expect(cfg.completionTimeout).toBe(7200 * 1000);
    expect(cfg.contextThreshold).toBe(100_000);
    expect(cfg.promptTimeout).toBe(30_000);
    expect(cfg.handoffTimeout).toBe(60_000);
    expect(cfg.maxRetries).toBe(2);
    expect(cfg.goalBudget).toBe(10_000_000);
  });

  it('parses AFK_AGENT_DEFAULT', async () => {
    process.env.AFK_AGENT_DEFAULT = 'codex';
    const cfg = await freshConfig();
    expect(cfg.agentDefault).toBe('codex');
  });

  it('parses AFK_TMUX_SESSION', async () => {
    process.env.AFK_TMUX_SESSION = 'my-session';
    const cfg = await freshConfig();
    expect(cfg.tmuxSession).toBe('my-session');
  });

  it('parses AFK_CONTEXT_THRESHOLD in tokens', async () => {
    process.env.AFK_CONTEXT_THRESHOLD = '80000';
    const cfg = await freshConfig();
    expect(cfg.contextThreshold).toBe(80_000);
  });

  it('parses AFK_WORKFLOW_HARD_TIMEOUT in ms', async () => {
    process.env.AFK_WORKFLOW_HARD_TIMEOUT = '3600000';
    const cfg = await freshConfig();
    expect(cfg.workflowHardTimeout).toBe(3_600_000);
  });

  it('parses AFK_COMPLETION_TIMEOUT in milliseconds', async () => {
    process.env.AFK_COMPLETION_TIMEOUT = '3600000';
    const cfg = await freshConfig();
    expect(cfg.completionTimeout).toBe(3_600_000);
  });

  it('parses AFK_PROMPT_TIMEOUT in ms', async () => {
    process.env.AFK_PROMPT_TIMEOUT = '15000';
    const cfg = await freshConfig();
    expect(cfg.promptTimeout).toBe(15_000);
  });

  it('parses AFK_HANDOFF_TIMEOUT in ms', async () => {
    process.env.AFK_HANDOFF_TIMEOUT = '120000';
    const cfg = await freshConfig();
    expect(cfg.handoffTimeout).toBe(120_000);
  });

  it('parses AFK_GOAL_BUDGET in tokens', async () => {
    process.env.AFK_GOAL_BUDGET = '2000000';
    const cfg = await freshConfig();
    expect(cfg.goalBudget).toBe(2_000_000);
  });

  it('parses AFK_MAX_RETRIES', async () => {
    process.env.AFK_MAX_RETRIES = '5';
    const cfg = await freshConfig();
    expect(cfg.maxRetries).toBe(5);
  });

  it('parses AFK_IDLE_TIMEOUT in ms', async () => {
    process.env.AFK_IDLE_TIMEOUT = '600000';
    const cfg = await freshConfig();
    expect(cfg.idleTimeout).toBe(600_000);
  });

  it('parses AFK_AC_CHECK_TIMEOUT in ms', async () => {
    process.env.AFK_AC_CHECK_TIMEOUT = '300000';
    const cfg = await freshConfig();
    expect(cfg.acCheckTimeout).toBe(300_000);
  });

  it('falls back to defaults for unparseable env values', async () => {
    process.env.AFK_CONTEXT_THRESHOLD = 'not-a-number';
    process.env.AFK_WORKFLOW_HARD_TIMEOUT = 'also-not';
    const cfg = await freshConfig();
    // Should fall back to defaults, not NaN
    expect(cfg.contextThreshold).toBe(100_000);
    expect(cfg.workflowHardTimeout).toBe(7200 * 1000);
  });
});

describe('SchedulerConfig env var loading', () => {
  const ORIGINAL = process.env;

  beforeEach(() => {
    process.env = { ...ORIGINAL };
    vi.resetModules();
  });

  afterEach(() => {
    process.env = ORIGINAL;
  });

  async function freshSchedulerConfig() {
    const { getSchedulerConfig: get } = await import('../src/lib/core/config/manager');
    return get();
  }

  it('defaults when no env vars set', async () => {
    const cfg = await freshSchedulerConfig();
    expect(cfg.maxConcurrent).toBe(3);
    expect(cfg.pollInterval).toBe(60);
    expect(cfg.requiredLabels).toEqual(['mode::afk', 'stage::ready-for-issues']);
    expect(cfg.excludeLabels).toContain('stage::afk-in-progress');
    expect(cfg.waveNotify).toBe(true);
    expect(cfg.updateDashboard).toBe(true);
  });

  it('parses AFK_SCHEDULER_MAX_CONCURRENT', async () => {
    process.env.AFK_SCHEDULER_MAX_CONCURRENT = '8';
    const cfg = await freshSchedulerConfig();
    expect(cfg.maxConcurrent).toBe(8);
  });

  it('parses AFK_SCHEDULER_POLL_INTERVAL', async () => {
    process.env.AFK_SCHEDULER_POLL_INTERVAL = '120';
    const cfg = await freshSchedulerConfig();
    expect(cfg.pollInterval).toBe(120);
  });

  it('parses comma-separated labels', async () => {
    process.env.AFK_SCHEDULER_REQUIRED_LABELS = 'mode::afk,priority::high';
    process.env.AFK_SCHEDULER_EXCLUDE_LABELS = 'stage::done,wip';
    const cfg = await freshSchedulerConfig();
    expect(cfg.requiredLabels).toEqual(['mode::afk', 'priority::high']);
    expect(cfg.excludeLabels).toEqual(['stage::done', 'wip']);
  });

  it('parses AFK_SCHEDULER_WAVE_NOTIFY=false', async () => {
    process.env.AFK_SCHEDULER_WAVE_NOTIFY = 'false';
    const cfg = await freshSchedulerConfig();
    expect(cfg.waveNotify).toBe(false);
  });

  it('parses AFK_SCHEDULER_UPDATE_DASHBOARD=false', async () => {
    process.env.AFK_SCHEDULER_UPDATE_DASHBOARD = 'false';
    const cfg = await freshSchedulerConfig();
    expect(cfg.updateDashboard).toBe(false);
  });
});
