import { describe, expect, it } from 'vitest';
import { buildBatchPrompt, buildExecutionPrompt, extractGoalComplete, parseAcVerificationFailure } from './execution-protocol';

describe('batch execution prompt protocol', () => {
  it('preserves the goal prompt and appends the requested completion marker', () => {
    const prompt = buildBatchPrompt('/goal implement issue #60');

    expect(prompt).toContain('/goal implement issue #60');
    expect(prompt).toContain('<goal_complete>');
    expect(prompt).toContain('"type":"goal_complete"');
    expect(prompt).toContain('</goal_complete>');
    expect(prompt).toContain('Do not switch branches');
    expect(prompt).toContain('pnpm vitest run');
  });

  it('extracts a typed completion payload from surrounding agent text', () => {
    expect(extractGoalComplete('finished\n<goal_complete>{"type":"goal_complete","summary":"done"}</goal_complete>')).toEqual({
      type: 'goal_complete', summary: 'done',
    });
    expect(extractGoalComplete('<goal_complete>invalid-json</goal_complete>')).toBeUndefined();
  });

  it('accepts a JSON-escaped slash in the completion closing tag', () => {
    expect(extractGoalComplete(
      '<goal_complete>{"type":"goal_complete","kind":"task","summary":"done"}<\\/goal_complete>',
    )).toEqual({ type: 'goal_complete', kind: 'task', summary: 'done' });
  });

  it('requires QA to report its PASS or FAIL outcome in the unified completion payload', () => {
    const prompt = buildBatchPrompt('/goal verify issue #60', 'qa');

    expect(prompt).toContain('<goal_complete>');
    expect(prompt).toContain('"kind":"qa"');
    expect(prompt).toContain('"result":"PASS|FAIL"');
  });

  it('requires original-branch AC verification to return structured pass or fail feedback', () => {
    const prompt = buildBatchPrompt('/goal verify issue #60', 'ac');

    expect(prompt).toContain('"kind":"ac_verification"');
    expect(prompt).toContain('"result":"PASS|FAIL"');
    expect(prompt).toContain('"failedCriteria"');
  });

  it('accepts only diagnosable AC failures for implementation retry', () => {
    expect(parseAcVerificationFailure({
      type: 'goal_complete', kind: 'ac_verification', result: 'FAIL', summary: 'shortcut is missing',
      failedCriteria: [{ id: 'search-shortcut', expected: '/s opens search', actual: '/ does something else' }],
    })).toEqual(expect.objectContaining({ result: 'FAIL', summary: 'shortcut is missing' }));
    expect(parseAcVerificationFailure({
      type: 'goal_complete', kind: 'ac_verification', result: 'FAIL', summary: 'shortcut is missing', failedCriteria: [],
    })).toBeUndefined();
  });

  it('injects the signal-file contract into interactive prompts', () => {
    const prompt = buildExecutionPrompt('/goal implement issue #60', 'interactive');

    expect(prompt).toContain('/goal implement issue #60');
    expect(prompt).toContain('.afk-signal.json');
    expect(prompt).toContain('atomically');
    expect(prompt).toContain('Do not only print');
    expect(prompt).toContain('Do not switch branches');
    expect(prompt).toContain('JSON.stringify');
    expect(prompt).toContain('JSON.parse');
  });

  it('injects the QA result contract into interactive QA prompts', () => {
    const prompt = buildExecutionPrompt('/goal verify issue #60', 'interactive', 'qa');

    expect(prompt).toContain('"kind":"qa"');
    expect(prompt).toContain('"result":"PASS|FAIL"');
  });
});
