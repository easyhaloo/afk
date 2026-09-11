import React from 'react';
import type { BacklogViewModel } from '../data/backlog-adapter';
import { normalizeRowText } from './ListView';
import { OperationalRow } from './OperationalRow';

export interface BacklogRowProps {
  backlog: BacklogViewModel;
  selected: boolean;
  width: number;
}

export function backlogStateColor(state: BacklogViewModel['state']): string {
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
  ].join(' · ');

  return (
    <OperationalRow
      width={width}
      selected={selected}
      status={backlog.state}
      statusColor={selected ? 'white' : backlogStateColor(backlog.state)}
      mode={backlog.executionMode}
      id={backlog.id}
      title={`backlog ${backlog.id} · ${normalizeRowText(backlog.title)}`}
      summary={summary}
    />
  );
}
