/**
 * WorkflowConfig and SchedulerConfig loading.
 *
 * Covers environment-variable-driven defaults for all values that were
 * previously hardcoded in source or in constants.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node:fs', () => ({
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => { throw new Error('not found'); }),
}));

import { loadWorkflowConfig } from '../src/infrastructure/config/manager';

describe('WorkflowConfig env var loading', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function freshConfig(env: Record<string, string | undefined> = {}) {
    return loadWorkflowConfig(process.cwd(), env);
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
    const cfg = await freshConfig({ AFK_AGENT_DEFAULT: 'codex' });
    expect(cfg.agentDefault).toBe('codex');
  });

  it('parses AFK_TMUX_SESSION', async () => {
    const cfg = await freshConfig({ AFK_TMUX_SESSION: 'my-session' });
    expect(cfg.tmuxSession).toBe('my-session');
  });

  it('parses AFK_CONTEXT_THRESHOLD in tokens', async () => {
    const cfg = await freshConfig({ AFK_CONTEXT_THRESHOLD: '80000' });
    expect(cfg.contextThreshold).toBe(80_000);
  });

  it('parses AFK_WORKFLOW_HARD_TIMEOUT in ms', async () => {
    const cfg = await freshConfig({ AFK_WORKFLOW_HARD_TIMEOUT: '3600000' });
    expect(cfg.workflowHardTimeout).toBe(3_600_000);
  });

  it('parses AFK_COMPLETION_TIMEOUT in milliseconds', async () => {
    const cfg = await freshConfig({ AFK_COMPLETION_TIMEOUT: '3600000' });
    expect(cfg.completionTimeout).toBe(3_600_000);
  });

  it('parses AFK_PROMPT_TIMEOUT in ms', async () => {
    const cfg = await freshConfig({ AFK_PROMPT_TIMEOUT: '15000' });
    expect(cfg.promptTimeout).toBe(15_000);
  });

  it('parses AFK_HANDOFF_TIMEOUT in ms', async () => {
    const cfg = await freshConfig({ AFK_HANDOFF_TIMEOUT: '120000' });
    expect(cfg.handoffTimeout).toBe(120_000);
  });

  it('parses AFK_GOAL_BUDGET in tokens', async () => {
    const cfg = await freshConfig({ AFK_GOAL_BUDGET: '2000000' });
    expect(cfg.goalBudget).toBe(2_000_000);
  });

  it('parses AFK_MAX_RETRIES', async () => {
    const cfg = await freshConfig({ AFK_MAX_RETRIES: '5' });
    expect(cfg.maxRetries).toBe(5);
  });

  it('parses AFK_IDLE_TIMEOUT in ms', async () => {
    const cfg = await freshConfig({ AFK_IDLE_TIMEOUT: '600000' });
    expect(cfg.idleTimeout).toBe(600_000);
  });

  it('parses AFK_AC_CHECK_TIMEOUT in ms', async () => {
    const cfg = await freshConfig({ AFK_AC_CHECK_TIMEOUT: '300000' });
    expect(cfg.acCheckTimeout).toBe(300_000);
  });

  it('falls back to defaults for unparseable env values', async () => {
    const cfg = await freshConfig({ AFK_CONTEXT_THRESHOLD: 'not-a-number', AFK_WORKFLOW_HARD_TIMEOUT: 'also-not' });
    expect(cfg.contextThreshold).toBe(100_000);
    expect(cfg.workflowHardTimeout).toBe(7200 * 1000);
  });
});

describe('SchedulerConfig env var loading', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  async function freshSchedulerConfig(env: Record<string, string | undefined> = {}) {
    const original = process.env;
    process.env = { ...original, ...env };
    try {
      const { getSchedulerConfig } = await import('../src/infrastructure/config/manager');
      return getSchedulerConfig();
    } finally {
      process.env = original;
    }
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
    const cfg = await freshSchedulerConfig({ AFK_SCHEDULER_MAX_CONCURRENT: '8' });
    expect(cfg.maxConcurrent).toBe(8);
  });

  it('parses AFK_SCHEDULER_POLL_INTERVAL', async () => {
    const cfg = await freshSchedulerConfig({ AFK_SCHEDULER_POLL_INTERVAL: '120' });
    expect(cfg.pollInterval).toBe(120);
  });

  it('parses comma-separated labels', async () => {
    const cfg = await freshSchedulerConfig({ AFK_SCHEDULER_REQUIRED_LABELS: 'mode::afk,priority::high', AFK_SCHEDULER_EXCLUDE_LABELS: 'stage::done,wip' });
    expect(cfg.requiredLabels).toEqual(['mode::afk', 'priority::high']);
    expect(cfg.excludeLabels).toEqual(['stage::done', 'wip']);
  });

  it('parses AFK_SCHEDULER_WAVE_NOTIFY=false', async () => {
    const cfg = await freshSchedulerConfig({ AFK_SCHEDULER_WAVE_NOTIFY: 'false' });
    expect(cfg.waveNotify).toBe(false);
  });

  it('parses AFK_SCHEDULER_UPDATE_DASHBOARD=false', async () => {
    const cfg = await freshSchedulerConfig({ AFK_SCHEDULER_UPDATE_DASHBOARD: 'false' });
    expect(cfg.updateDashboard).toBe(false);
  });
});
