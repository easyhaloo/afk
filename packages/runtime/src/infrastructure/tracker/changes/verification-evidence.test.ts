import { describe, expect, it } from 'vitest';
import { renderVerificationEvidence } from './verification-evidence.js';

describe('renderVerificationEvidence', () => {
  it('renders the summary, the per-criterion checks and the artifacts', () => {
    const rendered = renderVerificationEvidence({
      summary: 'All acceptance criteria were re-run in the QA worktree.',
      checks: [
        { command: 'cd apps/desktop && pnpm exec playwright test boot', expected: '5 passed' },
        { command: 'pnpm --filter afk-control-electron test', expected: '832 passed' },
      ],
      artifacts: [{ name: 'boot.png', url: 'https://github.test/releases/boot.png' }],
    });

    expect(rendered).toContain('## Verification Evidence');
    expect(rendered).toContain('All acceptance criteria were re-run in the QA worktree.');
    expect(rendered).toContain('| Check | Expected |');
    expect(rendered).toContain('| `cd apps/desktop && pnpm exec playwright test boot` | 5 passed |');
    expect(rendered).toContain('### Artifacts');
    expect(rendered).toContain('- [boot.png](https://github.test/releases/boot.png)');
  });

  it('keeps a pipe inside a command from breaking the table', () => {
    const rendered = renderVerificationEvidence({
      checks: [{ command: 'pnpm exec a | b', expected: 'ok' }],
    });
    expect(rendered).toContain('| `pnpm exec a \\| b` | ok |');
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
    expect(rendered).not.toContain('| Check | Expected |');
  });
});
