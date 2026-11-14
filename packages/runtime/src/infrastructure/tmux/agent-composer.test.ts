import { describe, expect, it } from 'vitest';
import {
  CODEX_EMPTY_COMPOSER_MARKER,
  agentModalInPane,
  claudeComposerIsEmpty,
  composerIsEmpty,
  supportsComposerState,
} from './agent-composer.js';

describe('supportsComposerState', () => {
  it('reads the composer of the agents whose composer AFK can see', () => {
    expect(supportsComposerState('codex')).toBe(true);
    expect(supportsComposerState('claude-code')).toBe(true);
    expect(supportsComposerState('opencode')).toBe(false);
  });
});

describe('composerIsEmpty', () => {
  it('reports an empty Codex composer when the placeholder is on screen', () => {
    const pane = [
      '• Working (11s • esc to interrupt) · Running hooks',
      `› ${CODEX_EMPTY_COMPOSER_MARKER}`,
      'openai/gpt-6.1-terra-cpr high · ~/.loop-workspace/…',
    ].join('\n');

    expect(composerIsEmpty('codex', pane)).toBe(true);
  });

  it('reports a filled Codex composer while the goal is still waiting for Enter', () => {
    const pane = [
      '› Implement the work item.',
      '  Backlog title: 发布并拉取企业路由映射（k-base 侧）',
      '  When the task is complete, atomically write a valid JSON',
      '  openai/gpt-6.1-terra-cpr high · ~/.loop-workspace/…',
    ].join('\n');

    expect(composerIsEmpty('codex', pane)).toBe(false);
  });

  it('treats providers without a readable marker as empty', () => {
    expect(composerIsEmpty('opencode', '› some prompt still typed')).toBe(true);
  });

  it('reports a filled composer when the placeholder never rendered', () => {
    expect(composerIsEmpty('codex', '')).toBe(false);
  });

  it('reports an empty Claude Code composer when the chevron line is bare', () => {
    const pane = [
      '⏺ The work is done.',
      '────────────────────────────────────────',
      '❯ ',
      '────────────────────────────────────────',
      '  afk-probe | z-ai/glm-5.3',
    ].join('\n');

    expect(composerIsEmpty('claude-code', pane)).toBe(true);
  });

  it('reports a filled Claude Code composer while the goal is waiting for Enter', () => {
    const pane = [
      '❯ Implement the work item.',
      '  Backlog title: fix(agent): claude-code 接入缺少 modal/composer/watcher',
      '────────────────────────────────────────',
      '  afk-probe | z-ai/glm-5.3',
    ].join('\n');

    expect(composerIsEmpty('claude-code', pane)).toBe(false);
  });

  it('reads the composer of the last chevron line, not of an older one', () => {
    const pane = [
      '❯ Implement the work item.',
      '⏺ The work is done.',
      '❯ ',
    ].join('\n');

    expect(composerIsEmpty('claude-code', pane)).toBe(true);
  });

  it('finds no composer to hold the goal when no chevron line is on screen', () => {
    expect(claudeComposerIsEmpty('(capture failed)')).toBe(true);
  });
});

describe('agentModalInPane', () => {
  it('names the folder trust question', () => {
    const pane = [
      '  Trust this folder? Codex can read, edit, and run files here, subject to your',
      '  permission settings. Folder settings can run code automatically, even',
      '  without a model request. Continue only if you trust these files. Your trust',
      '  decision will be saved.',
      '',
      '› 1. Trust and continue',
      '  2. Quit',
      '  enter continue · esc quit',
    ].join('\n');

    expect(agentModalInPane('codex', pane)?.name).toBe('Trust this folder?');
  });

  it('names the update prompt', () => {
    expect(agentModalInPane('codex', 'Update available')?.name).toBe('Update available');
  });

  it('reports no modal for an ordinary pane', () => {
    expect(agentModalInPane('codex', `› ${CODEX_EMPTY_COMPOSER_MARKER}`)).toBeUndefined();
  });

  it('reports no modal for providers AFK cannot read', () => {
    expect(agentModalInPane('opencode', 'Trust this folder?')).toBeUndefined();
  });

  it('answers the Claude Code folder-trust question by choosing to trust the folder', () => {
    const pane = [
      ' Claude Code\'ll be able to read, edit, and execute files here.',
      '',
      ' ❯ No, exit',
      '   Yes, I trust this folder',
      '',
      ' Enter to confirm · Esc to cancel',
    ].join('\n');

    const modal = agentModalInPane('claude-code', pane);

    // The default option is "No, exit": answering the question with Enter
    // alone closes the agent and leaves the worktree untouched.
    expect(modal?.name).toBe('folder trust');
    expect(modal?.select).toEqual(['Down']);
    expect(modal?.confirm).toBe('C-m');
  });

  it('does not mistake the Claude Code composer for the trust question', () => {
    expect(agentModalInPane('claude-code', '❯ Implement the work item.')).toBeUndefined();
  });
});
