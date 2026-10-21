import { describe, expect, it } from 'vitest';
import { dump } from 'js-yaml';
import type { BranchStrategyConfig } from '@afk/infrastructure';
import { parseTemplate } from './loader.js';

/**
 * A sample of every branch strategy the infrastructure package declares.
 *
 * The record is keyed by the strategy type, so a strategy added there
 * fails to compile in this file until it is given a sample - and the
 * sample then fails to parse until the template schema knows it. The
 * schema and the type are two answers to "which branch strategies
 * exist", and nothing but this held them together.
 */
const SAMPLES: Record<BranchStrategyConfig['type'], BranchStrategyConfig> = {
  issue: { type: 'issue', iid: 42 },
  named: { type: 'named', branch: 'afk/work-1' },
  'merge-to-head': { type: 'merge-to-head' },
  existing: { type: 'existing', branch: 'afk/work-1' },
};

function nested(value: unknown): string {
  return dump(value).trimEnd().split('\n').map(line => `      ${line}`).join('\n');
}

describe('the template schema and the branch strategies', () => {
  it('lets a template express every branch strategy the infrastructure declares', () => {
    for (const [type, strategy] of Object.entries(SAMPLES)) {
      const parsed = parseTemplate(`
name: strategy
version: 1
steps:
  - id: only
    role: implementer
    prompt: hi
    branch:
${nested(strategy)}
`, 'strategy');
      expect(parsed.steps[0]?.branch).toEqual(strategy);
      expect(type).toBe(strategy.type);
    }
  });
});
