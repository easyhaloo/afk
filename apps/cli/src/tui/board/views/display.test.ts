import { describe, expect, it } from 'vitest';
import {
  getExecutionModeColor,
  getExecutionModeIcon,
  getProjectPlatformColor,
  getProjectPlatformIcon,
  getStatusColor,
  getStatusIcon,
  type ProjectPlatform,
} from './display.js';

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
    expect(getStatusIcon('project_geelib')).toBe('GE');
    expect(getStatusColor('active')).toBe('yellow');
    expect(getStatusColor('stale')).toBe('red');
  });

  it('maps every tracker platform to a distinct icon and color', () => {
    expect(getProjectPlatformIcon('github')).toBe('GH');
    expect(getProjectPlatformIcon('gitlab')).toBe('GL');
    expect(getProjectPlatformIcon('geelib')).toBe('GE');
    expect(getProjectPlatformIcon(undefined)).toBe('GL');
    expect(getProjectPlatformColor('github')).toBe('white');
    expect(getProjectPlatformColor('gitlab')).toBe('magenta');
    expect(getProjectPlatformColor('geelib')).toBe('blue');
    const platforms: ProjectPlatform[] = ['github', 'gitlab', 'geelib'];
    const colors = platforms.map(p => getProjectPlatformColor(p));
    expect(new Set(colors).size).toBe(colors.length);
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
