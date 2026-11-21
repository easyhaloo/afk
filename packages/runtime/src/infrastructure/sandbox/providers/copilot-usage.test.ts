import { existsSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createCopilotUsageReport } from './copilot-usage.js';

describe('Copilot per-execution accounting', () => {
  it('sums native model counters and keeps concurrent reports separate', () => {
    const first = createCopilotUsageReport();
    const second = createCopilotUsageReport();
    expect(first.path).not.toBe(second.path);
    writeFileSync(first.path, JSON.stringify({ modelMetrics: {
      local: { usage: { inputTokens: 12, outputTokens: 3 } }, next: { usage: { inputTokens: 9, outputTokens: 5 } },
    } }));
    expect(first.finish()).toEqual({ inputTokens: 21, outputTokens: 8, totalTokens: 29 });
    expect(existsSync(first.path)).toBe(false);
    expect(second.finish()).toBeUndefined();
  });

  it.each(['{}', '{', 'x'.repeat(262145), '{"modelMetrics":{"local":{"usage":{"inputTokens":-1,"outputTokens":7}}}}'])('ignores missing or invalid counts', content => {
    const report = createCopilotUsageReport();
    writeFileSync(report.path, content);
    expect(report.finish()).toBeUndefined();
    expect(existsSync(report.path)).toBe(false);
  });
});
