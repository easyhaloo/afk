import { describe, expect, it } from 'vitest';
import {
  applyExecutionBaseBranch,
  parseExecutionBaseBranch,
  renderBaseVersionSection,
} from './execution-base.js';

describe('parseExecutionBaseBranch', () => {
  it('reads the ref out of the base version block', () => {
    const description = [
      '## Base Version',
      '',
      '- Base Ref: 2025-11-8-show',
      '',
      '## Acceptance Criteria',
      '',
      '- [ ] the router resolves the mapping',
    ].join('\n');

    expect(parseExecutionBaseBranch(description)).toBe('2025-11-8-show');
  });

  it('reads a ref that follows other facts in the block', () => {
    const description = ['## Base Version', '', '- Base Commit: abc123', '- Base Ref: release-2026', ''].join('\n');
    expect(parseExecutionBaseBranch(description)).toBe('release-2026');
  });

  it('ignores a branch that is only mentioned in the prose', () => {
    const description = [
      '## Context',
      '',
      'The change is cut from the branch feature/x.',
      '',
      '## Acceptance Criteria',
      '',
      '- [ ] merge into master',
    ].join('\n');

    expect(parseExecutionBaseBranch(description)).toBeUndefined();
  });

  it('stops at the next heading', () => {
    const description = ['## Base Version', '', '- Base Ref: main', '', '## Notes', '', '- Base Ref: other'].join('\n');
    expect(parseExecutionBaseBranch(description)).toBe('main');
  });

  it('reports nothing for an empty body', () => {
    expect(parseExecutionBaseBranch(undefined)).toBeUndefined();
    expect(parseExecutionBaseBranch('')).toBeUndefined();
  });
});

describe('renderBaseVersionSection', () => {
  it('renders the block AFK reads', () => {
    expect(renderBaseVersionSection('2025-11-8-show')).toBe('## Base Version\n\n- Base Ref: 2025-11-8-show\n');
  });
});

describe('applyExecutionBaseBranch', () => {
  it('replaces the block a body already declares', () => {
    const description = ['## Base Version', '', '- Base Ref: master', '', '## Context', '', 'text'].join('\n');
    const updated = applyExecutionBaseBranch(description, '2025-11-8-show');

    expect(parseExecutionBaseBranch(updated)).toBe('2025-11-8-show');
    expect(updated).not.toContain('- Base Ref: master');
    expect(updated).toContain('## Context');
    expect(updated).toContain('text');
  });

  it('adds the block to a body that declares none', () => {
    const updated = applyExecutionBaseBranch('## Context\n\ntext', 'main');

    expect(parseExecutionBaseBranch(updated)).toBe('main');
    expect(updated).toContain('## Context');
    expect(updated).toContain('text');
  });

  it('declares one base ref even when the body is rewritten twice', () => {
    const once = applyExecutionBaseBranch('text', 'main');
    const twice = applyExecutionBaseBranch(once, '2025-11-8-show');

    expect(twice.match(/Base Ref/g)).toHaveLength(1);
    expect(parseExecutionBaseBranch(twice)).toBe('2025-11-8-show');
  });
});
