import { describe, expect, it } from 'vitest';
import type { BacklogViewModel } from '../data/backlog-adapter';
import {
  BOARD_LANES,
  getBoardColumns,
  getBoardLayout,
  getBoardSelectionTarget,
  getBoardVisibleLaneIndexes,
  groupBacklogsByState,
} from './model';

function backlog(id: string, state: BacklogViewModel['state']): BacklogViewModel {
  return {
    id,
    title: `Backlog ${id}`,
    state,
    executionMode: 'afk',
    dependsOn: [],
    tags: [],
    branchName: `afk/backlog-${id}`,
    providerRef: `github:org/repo#${id}`,
  };
}

describe('BOARD_LANES', () => {
  it('keeps the canonical lane order', () => {
    expect(BOARD_LANES.map(lane => lane.state)).toEqual([
      'ready',
      'in_progress',
      'verification',
      'merge_ready',
      'rework',
      'blocked',
      'done',
    ]);
  });
});

describe('groupBacklogsByState', () => {
  it('groups items into the seven canonical lanes', () => {
    const lanes = groupBacklogsByState([
      backlog('1', 'ready'),
      backlog('2', 'in_progress'),
      backlog('3', 'verification'),
      backlog('4', 'merge_ready'),
      backlog('5', 'rework'),
      backlog('6', 'blocked'),
      backlog('7', 'done'),
    ]);

    expect(lanes.map(lane => lane.items.length)).toEqual([1, 1, 1, 1, 1, 1, 1]);
  });

  it('preserves input order inside a lane', () => {
    const lanes = groupBacklogsByState([
      backlog('1', 'ready'),
      backlog('2', 'ready'),
      backlog('3', 'blocked'),
    ]);

    expect(lanes[0].items.map(item => item.id)).toEqual(['1', '2']);
  });
});

describe('getBoardLayout', () => {
  it('selects the full lane set on wide terminals', () => {
    expect(getBoardLayout(160)).toMatchObject({ visibleLaneCount: 4, compact: false });
  });

  it('selects a three-lane window on medium terminals', () => {
    expect(getBoardLayout(120)).toMatchObject({ visibleLaneCount: 3, compact: false });
  });

  it('selects a single focused lane on compact terminals', () => {
    expect(getBoardLayout(80)).toMatchObject({ visibleLaneCount: 1, compact: true });
  });
});

describe('getBoardColumns', () => {
  it('keeps exceptions together and done as an archive column', () => {
    const columns = getBoardColumns(groupBacklogsByState([
      backlog('blocked', 'blocked'),
      backlog('rework', 'rework'),
      backlog('done', 'done'),
    ]));

    expect(columns.map(column => column.key)).toEqual([
      'ready', 'in_progress', 'verification', 'merge_ready', 'attention', 'done',
    ]);
    expect(columns[4].items.map(item => item.id)).toEqual(['blocked', 'rework']);
    expect(columns[5].items.map(item => item.id)).toEqual(['done']);
  });
});

describe('getBoardVisibleLaneIndexes', () => {
  it('centers the selected lane inside a three-lane window', () => {
    expect(getBoardVisibleLaneIndexes(3, 7, 3)).toEqual([2, 3, 4]);
  });

  it('clamps a small lane window at the start of the board', () => {
    expect(getBoardVisibleLaneIndexes(0, 7, 3)).toEqual([0, 1, 2]);
  });
});

describe('getBoardSelectionTarget', () => {
  const lanes = groupBacklogsByState([
    backlog('1', 'ready'),
    backlog('2', 'ready'),
    backlog('3', 'verification'),
    backlog('4', 'done'),
    backlog('5', 'done'),
  ]);
  const columns = getBoardColumns(lanes);

  it('moves within the focused lane', () => {
    expect(getBoardSelectionTarget(columns, '1', 'down')).toBe('2');
    expect(getBoardSelectionTarget(columns, '2', 'up')).toBe('1');
  });

  it('moves laterally while preserving item ordinal when possible', () => {
    expect(getBoardSelectionTarget(columns, '2', 'right')).toBe('3');
    expect(getBoardSelectionTarget(columns, '5', 'left')).toBe('3');
  });

  it('keeps the selection stable at lane boundaries', () => {
    expect(getBoardSelectionTarget(columns, '1', 'up')).toBe('1');
    expect(getBoardSelectionTarget(columns, '4', 'right')).toBe('4');
    expect(getBoardSelectionTarget(columns, '5', 'right')).toBe('5');
  });
});
