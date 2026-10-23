import { describe, expect, it } from 'vitest';
import { getTaskBacklogId } from './task-types.js';

describe('getTaskBacklogId', () => {
  it('never substitutes runId for a missing backlog identity', () => {
    expect(getTaskBacklogId({ runId: 'run-42' } as never)).toBe('unknown');
  });
});
