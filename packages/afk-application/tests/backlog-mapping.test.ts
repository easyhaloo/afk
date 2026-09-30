import { describe, expect, it } from 'vitest';
import {
  BACKLOG_EXECUTION_MODES,
  BACKLOG_STATES,
  coreWorkModeByExecutionMode,
  coreWorkStateByBacklogState,
  toCoreWorkMode,
  toCoreWorkState,
} from '../src/index.js';

describe('backlog -> core vocabulary', () => {
  it('maps every backlog state to its core work state', () => {
    expect(toCoreWorkState('ready')).toBe('ready');
    expect(toCoreWorkState('rework')).toBe('rework');
    expect(toCoreWorkState('in_progress')).toBe('implementing');
    expect(toCoreWorkState('verification')).toBe('verifying');
    expect(toCoreWorkState('merge_ready')).toBe('merge_ready');
    expect(toCoreWorkState('done')).toBe('done');
    expect(toCoreWorkState('blocked')).toBe('blocked');
  });

  it('maps every execution mode to its core work mode', () => {
    expect(toCoreWorkMode('afk')).toBe('autonomous');
    expect(toCoreWorkMode('hitl')).toBe('human');
  });

  it('covers the declared vocabularies exactly, in both directions', () => {
    expect(Object.keys(coreWorkStateByBacklogState).sort()).toEqual([...BACKLOG_STATES].sort());
    expect(Object.keys(coreWorkModeByExecutionMode).sort()).toEqual([...BACKLOG_EXECUTION_MODES].sort());
  });

  it('keeps the public vocabularies reachable from the package barrel', () => {
    // Desktop reaches these values through the pre-bundled CJS application.cjs,
    // which is built from this barrel. A missing re-export silently breaks the
    // Electron adapter at runtime rather than at build time.
    expect(BACKLOG_STATES).toContain('in_progress');
    expect(BACKLOG_EXECUTION_MODES).toContain('hitl');
  });
});
