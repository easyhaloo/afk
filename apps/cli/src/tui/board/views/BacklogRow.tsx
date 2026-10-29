import React from 'react';
import type { BacklogViewModel } from '../data/backlog-adapter.js';
import { normalizeRowText } from './ListView.js';
import { OperationalRow } from './OperationalRow.js';

export interface BacklogRowProps {
  backlog: BacklogViewModel;
  selected: boolean;
  width: number;
}

/**
 * The label a backlog row shows in its status slot.
 *
 * A PRD anchor is a container and has no lifecycle position, so it shows its
 * role instead of an empty state. It is never mixed in with the executable
 * items, which is what the separate role label makes visible.
 */
export type BacklogStatusLabel = Exclude<BacklogViewModel['state'], undefined> | 'prd' | 'none';

export function backlogStatusLabel(backlog: BacklogViewModel): BacklogStatusLabel {
  if (backlog.kind === 'prd') return 'prd';
  return backlog.state ?? 'none';
}

export function backlogStateColor(state: BacklogStatusLabel): string {
  if (state === 'prd') return 'blue';
  if (state === 'blocked') return 'red';
  if (state === 'in_progress') return 'yellow';
  if (state === 'verification') return 'magenta';
  if (state === 'merge_ready') return 'blue';
  if (state === 'done') return 'green';
  return 'cyan';
}

export function BacklogRow({ backlog, selected, width }: BacklogRowProps) {
  const summary = [
    `parent ${normalizeRowText(backlog.parentId || '') || '-'}`,
    `depends ${backlog.dependsOn.length}`,
    backlog.tags.map(normalizeRowText).filter(Boolean).join(', ') || '-',
  ].filter(Boolean).join(' · ');

  return (
    <OperationalRow
      width={width}
      selected={selected}
      status={backlogStatusLabel(backlog)}
      statusColor={selected ? 'white' : backlogStateColor(backlogStatusLabel(backlog))}
      mode={backlog.executionMode}
      runtimeStatus={[backlog.runStatus ?? 'no-runtime', backlog.phase, backlog.progress].filter(Boolean).join('/')}
      id={backlog.id}
      title={`backlog ${backlog.id} · ${normalizeRowText(backlog.title)}`}
      summary={summary}
    />
  );
}
