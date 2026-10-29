import { describe, expect, it } from 'vitest';
import {
  BACKLOG_EXECUTION_MODES,
  BACKLOG_KINDS,
  BACKLOG_STATES,
  coreWorkKindByBacklogKind,
  coreWorkModeByExecutionMode,
  coreWorkStateByBacklogState,
  toCoreWorkMode,
  toCoreWorkState,
} from './index.js';

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

  it('maps a PRD anchor to a role, not to a state', () => {
    // An anchor is a container: it has no lifecycle position, so it has no
    // core work state either. The role travels on its own.
    expect(toCoreWorkState(undefined)).toBeUndefined();
    expect(coreWorkKindByBacklogKind.prd).toBe('prd');
  });

  it('maps every execution mode to its core work mode', () => {
    expect(toCoreWorkMode('afk')).toBe('autonomous');
    expect(toCoreWorkMode('hitl')).toBe('human');
  });

  it('covers the declared vocabularies exactly, in both directions', () => {
    expect(Object.keys(coreWorkStateByBacklogState).sort()).toEqual([...BACKLOG_STATES].sort());
    expect(Object.keys(coreWorkModeByExecutionMode).sort()).toEqual([...BACKLOG_EXECUTION_MODES].sort());
    expect(Object.keys(coreWorkKindByBacklogKind).sort()).toEqual([...BACKLOG_KINDS].sort());
  });

  it('keeps the public vocabularies reachable from the package barrel', () => {
    // The Electron adapter imports these values straight from this barrel at
    // runtime. A missing re-export breaks the desktop main process at runtime
    // rather than at build time, so keep the assertion explicit.
    expect(BACKLOG_STATES).toContain('in_progress');
    expect(BACKLOG_EXECUTION_MODES).toContain('hitl');
  });
});
