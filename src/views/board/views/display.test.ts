import { describe, expect, it } from 'vitest';
import {
  getExecutionModeColor,
  getExecutionModeIcon,
  getStatusColor,
  getStatusIcon,
} from './display';

describe('global status display', () => {
  it('maps backlog lifecycle states to compact icons and semantic colors', () => {
    expect(getStatusIcon('ready')).toBe('○');
    expect(getStatusIcon('in_progress')).toBe('▶');
    expect(getStatusIcon('verification')).toBe('◌');
    expect(getStatusIcon('merge_ready')).toBe('⇥');
    expect(getStatusIcon('rework')).toBe('↺');
    expect(getStatusIcon('blocked')).toBe('!');
    expect(getStatusIcon('done')).toBe('✓');
    expect(getStatusColor('blocked')).toBe('red');
    expect(getStatusColor('done')).toBe('green');
  });

  it('maps runtime and project statuses without leaking raw status labels', () => {
    expect(getStatusIcon('active')).toBe('●');
    expect(getStatusIcon('stale')).toBe('!');
    expect(getStatusIcon('project')).toBe('◆');
    expect(getStatusIcon('project_github')).toBe('GH');
    expect(getStatusIcon('project_gitlab')).toBe('GL');
    expect(getStatusColor('active')).toBe('yellow');
    expect(getStatusColor('stale')).toBe('red');
  });

  it('uses the same icons for AFK/batch and HITL/interactive modes', () => {
    expect(getExecutionModeIcon('afk')).toBe('⚙');
    expect(getExecutionModeIcon('batch')).toBe('⚙');
    expect(getExecutionModeIcon('hitl')).toBe('◇');
    expect(getExecutionModeIcon('interactive')).toBe('◇');
    expect(getExecutionModeColor('afk')).toBe('cyan');
    expect(getExecutionModeColor('interactive')).toBe('yellow');
    expect(getExecutionModeIcon('main')).toBeUndefined();
  });
});
