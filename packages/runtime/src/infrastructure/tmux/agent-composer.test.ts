import { describe, expect, it } from 'vitest';
import {
  CODEX_EMPTY_COMPOSER_MARKER,
  composerIsEmpty,
  supportsComposerState,
} from './agent-composer.js';

describe('supportsComposerState', () => {
  it('reads the Codex composer and leaves other providers unobserved', () => {
    expect(supportsComposerState('codex')).toBe(true);
    expect(supportsComposerState('claude-code')).toBe(false);
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
    expect(composerIsEmpty('claude-code', '› some prompt still typed')).toBe(true);
  });

  it('reports a filled composer when the placeholder never rendered', () => {
    expect(composerIsEmpty('codex', '')).toBe(false);
  });
});
