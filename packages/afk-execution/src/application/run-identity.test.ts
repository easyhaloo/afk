import { describe, expect, it } from 'vitest';
import { handoffDocName, parseHandoffDocName, parseRunId, runIdFor } from './run-identity.js';

describe('run identity', () => {
  it('names a session after the work item and the generation', () => {
    expect(runIdFor({ iid: '42', generation: 3 })).toBe('issue-42-gen-3');
    expect(runIdFor({ iid: '42', generation: 'terminal' })).toBe('issue-42-terminal');
  });

  it('reads a session name back', () => {
    expect(parseRunId('issue-42-gen-3')).toEqual({ iid: '42', generation: 3 });
    expect(parseRunId('issue-42-terminal')).toEqual({ iid: '42', generation: 'terminal' });
  });

  it('says nothing about a name that is not one', () => {
    expect(parseRunId('issue-42')).toBeUndefined();
    expect(parseRunId('run-42-gen-3')).toBeUndefined();
    expect(parseRunId('issue-42-gen-')).toBeUndefined();
  });

  it('names the handoff document after the same thing', () => {
    expect(handoffDocName({ iid: '42', generation: 3 })).toBe('handoff-42-3.md');
    expect(handoffDocName({ iid: '42', generation: 'terminal' })).toBe('handoff-42-terminal.md');
  });

  it('reads a handoff document name back', () => {
    expect(parseHandoffDocName('handoff-42-3.md')).toEqual({ iid: '42', generation: 3 });
    expect(parseHandoffDocName('handoff-42-terminal.md')).toEqual({ iid: '42', generation: 'terminal' });
    expect(parseHandoffDocName('handoff-42.md')).toBeUndefined();
  });

  it('round-trips a generation through both spellings', () => {
    const identity = { iid: '42', generation: 7 } as const;
    expect(parseRunId(runIdFor(identity))).toEqual(identity);
    expect(parseHandoffDocName(handoffDocName(identity))).toEqual(identity);
  });
});
