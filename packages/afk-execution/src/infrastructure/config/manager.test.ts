import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_WORKFLOW_CONFIG, loadWorkflowConfig } from './manager.js';

async function workspaceWith(config: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'afk-config-'));
  await mkdir(join(root, '.afk'), { recursive: true });
  await writeFile(join(root, '.afk', 'config.yml'), config, 'utf8');
  return root;
}

describe('loadWorkflowConfig', () => {
  it('takes the value from the project file when it has one', async () => {
    const root = await workspaceWith('agentDefault: codex\nmaxRetries: 5\n');

    const config = loadWorkflowConfig(root, { AFK_AGENT_DEFAULT: 'claude-code', AFK_MAX_RETRIES: '9' });

    expect(config.agentDefault).toBe('codex');
    expect(config.maxRetries).toBe(5);
  });

  it('falls back to the environment when the file does not say', async () => {
    const root = await workspaceWith('agentDefault: codex\n');

    const config = loadWorkflowConfig(root, { AFK_MAX_RETRIES: '9' });

    expect(config.maxRetries).toBe(9);
  });

  it('honours the goal budget in the environment', async () => {
    const root = await workspaceWith('agentDefault: codex\n');

    const config = loadWorkflowConfig(root, { AFK_GOAL_BUDGET: '4242' });

    expect(config.goalBudget).toBe(4242);
  });

  it('falls back to the defaults when neither says', async () => {
    const root = await mkdtemp(join(tmpdir(), 'afk-config-'));

    const config = loadWorkflowConfig(root, {});

    expect(config.agentDefault).toBe(DEFAULT_WORKFLOW_CONFIG.agentDefault);
    expect(config.goalBudget).toBe(DEFAULT_WORKFLOW_CONFIG.goalBudget);
    expect(config.trackerTargetBranch).toBe(DEFAULT_WORKFLOW_CONFIG.trackerTargetBranch);
  });

  it('treats an empty configuration file as no configuration', async () => {
    const root = await workspaceWith('');

    const config = loadWorkflowConfig(root, {});

    expect(config.agentDefault).toBe(DEFAULT_WORKFLOW_CONFIG.agentDefault);
  });

  it('refuses a rework limit that is not a positive integer', async () => {
    const root = await workspaceWith('maxQaReworkAttempts: 0\n');

    expect(() => loadWorkflowConfig(root, {})).toThrow(/maxQaReworkAttempts/);
  });
});
