import type { BacklogViewModel } from '../data/backlog-adapter';
import { getStatusIcon } from '../views/display';

export { getExecutionModeIcon } from '../views/display';
export { getStatusIcon as getBacklogStateIcon } from '../views/display';

export const BOARD_LANES = [
  { state: 'ready', label: 'Ready', shortLabel: 'ready' },
  { state: 'in_progress', label: 'Processing', shortLabel: 'processing' },
  { state: 'verification', label: 'Verification', shortLabel: 'verify' },
  { state: 'merge_ready', label: 'Merge', shortLabel: 'merge' },
  { state: 'rework', label: 'Rework', shortLabel: 'rework' },
  { state: 'blocked', label: 'Blocked', shortLabel: 'blocked' },
  { state: 'done', label: 'Done', shortLabel: 'done' },
] as const;

export const BOARD_PRIMARY_STATES = ['ready', 'in_progress', 'verification', 'merge_ready'] as const;

export interface BoardLane {
  state: BacklogViewModel['state'];
  label: string;
  shortLabel: string;
  items: BacklogViewModel[];
}

export type BoardColumnKind = 'primary' | 'attention' | 'done';

export interface BoardColumn {
  key: string;
  label: string;
  shortLabel: string;
  kind: BoardColumnKind;
  state?: BacklogViewModel['state'];
  items: BacklogViewModel[];
}

export interface BoardLayout {
  visibleLaneCount: 1 | 3 | 4;
  laneWidth: number;
  compact: boolean;
}

export function getBoardColumnIcon(column: Pick<BoardColumn, 'kind' | 'state' | 'items'>): string {
  if (column.kind === 'attention') return column.items.some(item => item.state === 'blocked') ? '!' : '↺';
  if (column.state) return getStatusIcon(column.state);
  return '✓';
}

type Direction = 'up' | 'down' | 'left' | 'right' | 'top' | 'bottom';

export function groupBacklogsByState(items: BacklogViewModel[]): BoardLane[] {
  const buckets = new Map<BacklogViewModel['state'], BacklogViewModel[]>();
  for (const lane of BOARD_LANES) buckets.set(lane.state, []);
  for (const item of items) buckets.get(item.state)?.push(item);
  return BOARD_LANES.map(lane => ({
    state: lane.state,
    label: lane.label,
    shortLabel: lane.shortLabel,
    items: buckets.get(lane.state) ?? [],
  }));
}

export function getBoardLayout(width: number): BoardLayout {
  if (width >= 154) return { visibleLaneCount: 4, laneWidth: Math.max(24, Math.floor(width / 4)), compact: false };
  if (width >= 100) return { visibleLaneCount: 3, laneWidth: Math.max(24, Math.floor(width / 3)), compact: false };
  return { visibleLaneCount: 1, laneWidth: Math.max(1, width), compact: true };
}

export function getBoardVisibleLaneIndexes(focusedLane: number, laneCount: number, visibleLaneCount: 1 | 3 | 4 | 7): number[] {
  if (visibleLaneCount >= laneCount) return Array.from({ length: laneCount }, (_, index) => index);
  if (visibleLaneCount === 1) return [Math.min(Math.max(focusedLane, 0), laneCount - 1)];

  const halfWindow = Math.floor(visibleLaneCount / 2);
  let start = focusedLane - halfWindow;
  let end = focusedLane + halfWindow;

  if (start < 0) {
    end += -start;
    start = 0;
  }
  if (end >= laneCount) {
    start -= end - (laneCount - 1);
    end = laneCount - 1;
  }
  start = Math.max(0, start);
  end = Math.min(laneCount - 1, end);

  const indexes = Array.from({ length: end - start + 1 }, (_, index) => start + index);
  return indexes.slice(0, visibleLaneCount);
}

export function getBoardColumns(lanes: BoardLane[]): BoardColumn[] {
  const primaryColumns: BoardColumn[] = BOARD_PRIMARY_STATES.map(state => {
    const lane = lanes.find(candidate => candidate.state === state);
    return {
      key: state,
      label: lane?.label ?? state,
      shortLabel: lane?.shortLabel ?? state,
      kind: 'primary',
      state,
      items: lane?.items ?? [],
    };
  });
  const blocked = lanes.find(lane => lane.state === 'blocked')?.items ?? [];
  const rework = lanes.find(lane => lane.state === 'rework')?.items ?? [];
  const done = lanes.find(lane => lane.state === 'done')?.items ?? [];

  return [
    ...primaryColumns,
    { key: 'attention', label: 'Attention', shortLabel: 'attention', kind: 'attention', items: [...blocked, ...rework] },
    { key: 'done', label: 'Done', shortLabel: 'done', kind: 'done', state: 'done', items: done },
  ];
}

function findPosition(columns: BoardColumn[], selectedId: string | undefined): { columnIndex: number; itemIndex: number } | undefined {
  if (!selectedId) return undefined;
  for (let columnIndex = 0; columnIndex < columns.length; columnIndex++) {
    const itemIndex = columns[columnIndex].items.findIndex(item => item.id === selectedId);
    if (itemIndex >= 0) return { columnIndex, itemIndex };
  }
  return undefined;
}

function columnWithItems(columns: BoardColumn[], start: number, direction: -1 | 1): number | undefined {
  for (let index = start; index >= 0 && index < columns.length; index += direction) {
    if (columns[index].items.length > 0) return index;
  }
  return undefined;
}

export function getBoardSelectionTarget(
  columns: BoardColumn[],
  selectedId: string | undefined,
  direction: Direction,
): string | undefined {
  const position = findPosition(columns, selectedId);
  if (!position) return selectedId;

  const currentColumn = columns[position.columnIndex];
  const currentItems = currentColumn.items;

  if (direction === 'top') return currentItems[0]?.id ?? selectedId;
  if (direction === 'bottom') return currentItems[currentItems.length - 1]?.id ?? selectedId;
  if (direction === 'up') return currentItems[Math.max(0, position.itemIndex - 1)]?.id ?? selectedId;
  if (direction === 'down') return currentItems[Math.min(currentItems.length - 1, position.itemIndex + 1)]?.id ?? selectedId;

  const delta = direction === 'left' ? -1 : 1;
  const targetColumnIndex = columnWithItems(columns, position.columnIndex + delta, delta as -1 | 1);
  if (targetColumnIndex === undefined) return selectedId;

  const targetItems = columns[targetColumnIndex].items;
  const targetIndex = Math.min(position.itemIndex, targetItems.length - 1);
  return targetItems[targetIndex]?.id ?? selectedId;
}

export function getFocusedColumnIndex(columns: BoardColumn[], selectedId: string | undefined): number {
  return findPosition(columns, selectedId)?.columnIndex ?? 0;
}
