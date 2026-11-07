import { describe, expect, it } from 'vitest';
import {
  assemblePrompt,
  buildBatchPrompt,
  buildBatchPromptSegments,
  buildExecutionPrompt,
  buildExecutionPromptSegments,
  buildInteractivePromptSegments,
  extractGoalComplete,
  parseAcVerificationFailure,
} from './execution-protocol.js';

describe('batch execution prompt protocol', () => {
  it('treats /goal as prompt syntax instead of a Claude slash command in batch mode', () => {
    const prompt = buildBatchPrompt('/goal implement issue #60');

    expect(prompt).toContain('implement issue #60');
    expect(prompt).not.toMatch(/^\/goal\b/i);
    expect(prompt).toContain('<goal_complete>');
    expect(prompt).toContain('"type":"goal_complete"');
    expect(prompt).toContain('</goal_complete>');
    expect(prompt).toContain('Do not switch branches');
    expect(prompt).toContain('pnpm vitest run');
  });

  it('states the push boundary in both transports, so the agent knows where it may push', () => {
    const batch = buildBatchPrompt('/goal implement issue #60');
    const interactive = buildInteractivePromptSegments([{ label: 'goal', text: '/goal implement issue #60' }])
      .map(segment => segment.text).join('\n');

    for (const prompt of [batch, interactive]) {
      expect(prompt).toContain('Push your commits only to the branch you are working on');
      expect(prompt).toContain('never push to them');
      expect(prompt).toContain('Publishing the change request is AFK');
    }
  });

  it('extracts a typed completion payload from surrounding agent text', () => {    expect(extractGoalComplete('finished\n<goal_complete>{"type":"goal_complete","summary":"done"}</goal_complete>')).toEqual({
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

  it('tells the QA agent to register the binary evidence it produced', () => {
    const batch = buildBatchPrompt('/goal verify issue #60', 'qa');
    const interactive = buildExecutionPrompt('/goal verify issue #60', 'interactive', 'qa');

    for (const prompt of [batch, interactive]) {
      expect(prompt).toContain('.afk/artifacts.txt');
      expect(prompt).toContain('one absolute path per line');
    }
  });

  it('asks the QA agent to separate the verdict, the observations and the caveats', () => {
    const batch = buildBatchPrompt('/goal verify issue #60', 'qa');
    const interactive = buildExecutionPrompt('/goal verify issue #60', 'interactive', 'qa');

    for (const prompt of [batch, interactive]) {
      expect(prompt).toContain('"observations"');
      expect(prompt).toContain('"notes"');
      expect(prompt).toContain('"requiredChecks"');
      expect(prompt).toContain('not acceptance evidence');
    }
  });

  it('keeps the artifact instruction out of prompts that are not QA verification', () => {
    expect(buildBatchPrompt('/goal implement issue #60')).not.toContain('.afk/artifacts.txt');
    expect(buildBatchPrompt('/goal verify issue #60', 'ac')).not.toContain('.afk/artifacts.txt');
    expect(buildExecutionPrompt('/goal implement issue #60', 'interactive')).not.toContain('.afk/artifacts.txt');
  });

  it('drives the QA agent to run the project-owned E2E verification without prescribing a harness', () => {
    const batch = buildBatchPrompt('/goal verify issue #60', 'qa');
    const interactive = buildExecutionPrompt('/goal verify issue #60', 'interactive', 'qa');

    for (const prompt of [batch, interactive]) {
      expect(prompt).toContain('End-to-end verification');
      expect(prompt).toContain('detect from the project itself');
      expect(prompt).toContain('.afk/artifacts.txt');
      expect(prompt).toContain('do not invent a parallel E2E harness');
    }
  });

  it('keeps the E2E instruction out of prompts that are not QA verification', () => {
    expect(buildBatchPrompt('/goal implement issue #60')).not.toContain('End-to-end verification');
    expect(buildBatchPrompt('/goal verify issue #60', 'ac')).not.toContain('End-to-end verification');
    expect(buildExecutionPrompt('/goal implement issue #60', 'interactive')).not.toContain('End-to-end verification');
  });
});

/**
 * The prompt is built from labelled pieces, so a prompt that is too long for
 * the provider can name the piece that is responsible.
 */
describe('prompt segments', () => {
  const goal = [
    { label: 'goal task statement', text: '/goal verify issue #60' },
    { label: 'backlog title', text: 'Backlog title: search mode' },
    { label: 'backlog context pointer', text: 'Backlog context: read .afk/backlog-context.md first' },
  ];

  it('keeps the goal pieces and adds the completion protocol in interactive mode', () => {
    const segments = buildInteractivePromptSegments(goal, 'qa');

    expect(segments.map(segment => segment.label)).toEqual([
      'goal task statement',
      'backlog title',
      'backlog context pointer',
      'completion protocol',
    ]);
    expect(segments[0].text).toBe('/goal verify issue #60');
    expect(segments[3].text).toContain('.afk-signal.json');
  });

  it('merges the goal into one batch piece and drops the /goal command', () => {
    const segments = buildBatchPromptSegments(goal, 'qa');

    expect(segments.map(segment => segment.label)).toEqual(['goal', 'completion protocol']);
    expect(segments[0].text).toBe('AFK batch goal:\nverify issue #60\n\nBacklog title: search mode\n\nBacklog context: read .afk/backlog-context.md first');
  });

  it('assembles the segments into the prompt the provider reads', () => {
    const segments = buildExecutionPromptSegments(goal, 'interactive', 'qa');
    const prompt = assemblePrompt(segments);

    expect(prompt.startsWith('/goal verify issue #60')).toBe(true);
    expect(prompt).toContain('Backlog title: search mode');
    expect(prompt).toContain('.afk/backlog-context.md');
    expect(prompt).toContain('.afk-signal.json');
    // The pieces are separated, not run together.
    expect(prompt).toContain('/goal verify issue #60\n\nBacklog title: search mode');
  });

  it('leaves the goal alone when there is no execution mode', () => {
    const segments = buildExecutionPromptSegments(goal, undefined, 'task');

    expect(segments).toEqual(goal);
    expect(assemblePrompt(segments)).toBe(assemblePrompt(goal));
  });
});
