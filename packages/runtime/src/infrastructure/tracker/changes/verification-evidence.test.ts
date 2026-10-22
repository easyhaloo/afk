import { describe, expect, it } from 'vitest';
import { renderVerificationEvidence } from './verification-evidence.js';

describe('renderVerificationEvidence', () => {
  it('renders the summary, the criteria, the observations and the artifacts', () => {
    const rendered = renderVerificationEvidence({
      summary: 'Every acceptance criterion was re-run in the QA worktree.',
      checks: [
        { command: 'cd apps/desktop && pnpm exec playwright test boot', expected: '5 passed' },
        { command: 'pnpm --filter afk-control-electron test', expected: '832 passed' },
      ],
      observations: [
        { claim: '设置 entry is absent from the navigation groups', evidence: '0 occurrences, 8 group items' },
        { claim: 'the entry hugs the sidebar bottom edge' },
      ],
      artifacts: [{ name: 'boot.png', url: 'https://github.test/releases/boot.png' }],
    });

    expect(rendered).toContain('## Verification Evidence');
    expect(rendered).toContain('Every acceptance criterion was re-run in the QA worktree.');
    expect(rendered).toContain('### Acceptance criteria');
    expect(rendered).toContain('| Check | Expected |');
    expect(rendered).toContain('| `cd apps/desktop && pnpm exec playwright test boot` | 5 passed |');
    expect(rendered).toContain('### Observations');
    expect(rendered).toContain('- 设置 entry is absent from the navigation groups — 0 occurrences, 8 group items');
    expect(rendered).toContain('- the entry hugs the sidebar bottom edge');
    expect(rendered).toContain('### Artifacts');
    expect(rendered).toContain('- [boot.png](https://github.test/releases/boot.png)');
  });

  it('keeps a pipe inside a command from breaking the table', () => {
    const rendered = renderVerificationEvidence({
      checks: [{ command: 'pnpm exec a | b', expected: 'ok' }],
    });
    expect(rendered).toContain('| `pnpm exec a \\| b` | ok |');
  });

  it('renders the run notes apart from the acceptance evidence', () => {
    const rendered = renderVerificationEvidence({
      summary: 'All criteria passed.',
      observations: [{ claim: 'the entry is in the bottom area' }],
      notes: 'the worktree node_modules was a symlink pnpm rejects, so it was materialized as a real directory',
    });

    expect(rendered).toContain('> **Run notes**');
    expect(rendered).toContain('> the worktree node_modules was a symlink pnpm rejects');
    // The note must not read as an acceptance observation.
    expect(rendered).not.toContain('- the worktree node_modules');
  });

  it('renders nothing when the run proved nothing', () => {
    expect(renderVerificationEvidence(undefined)).toBe('');
    expect(renderVerificationEvidence({})).toBe('');
    expect(renderVerificationEvidence({ summary: '   ' })).toBe('');
  });

  it('renders the artifacts without a summary or checks', () => {
    const rendered = renderVerificationEvidence({
      artifacts: [{ name: 'trace.zip', url: 'https://github.test/releases/trace.zip' }],
    });
    expect(rendered).toContain('### Artifacts');
    expect(rendered).toContain('- [trace.zip](https://github.test/releases/trace.zip)');
    expect(rendered).not.toContain('### Acceptance criteria');
    expect(rendered).not.toContain('### Observations');
  });

  it('omits the observations section when the run reported none', () => {
    const rendered = renderVerificationEvidence({
      summary: 'All criteria passed.',
      checks: [{ command: 'pnpm test', expected: 'ok' }],
    });
    expect(rendered).toContain('### Acceptance criteria');
    expect(rendered).not.toContain('### Observations');
    expect(rendered).not.toContain('> **Run notes**');
  });
  it('shows the actual outcome next to the expectation when the run reported one', () => {
    const rendered = renderVerificationEvidence({
      summary: 'Every criterion passed.',
      checks: [
        { command: 'pnpm exec playwright test boot', expected: '5 passed', actual: '5 passed (21.3s)' },
        { command: 'pnpm --filter afk-control-electron test', expected: 'all unit tests pass', actual: '832 passed in 87 files' },
      ],
    });

    expect(rendered).toContain('| Check | Expected | Actual |');
    expect(rendered).toContain('| `pnpm exec playwright test boot` | 5 passed | 5 passed (21.3s) |');
    expect(rendered).toContain('| `pnpm --filter afk-control-electron test` | all unit tests pass | 832 passed in 87 files |');
  });

  it('keeps the two column table when no run reported an actual outcome', () => {
    const rendered = renderVerificationEvidence({
      checks: [{ command: 'pnpm exec playwright test boot', expected: '5 passed' }],
    });

    expect(rendered).toContain('| Check | Expected |');
    expect(rendered).not.toContain('| Check | Expected | Actual |');
  });
});
