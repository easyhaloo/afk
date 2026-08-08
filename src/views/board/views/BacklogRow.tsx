import React from 'react';
import type { BacklogViewModel } from '../data/backlog-adapter';
import { normalizeRowText } from './ListView';
import { OperationalRow } from './OperationalRow';
import { getStatusColor } from './display';

export interface BacklogRowProps {
  backlog: BacklogViewModel;
  selected: boolean;
  width: number;
}

export function backlogStateColor(state: BacklogViewModel['state']): string {
  return getStatusColor(state);
}

export function BacklogRow({ backlog, selected, width }: BacklogRowProps) {
  return (
    <OperationalRow
      width={width}
      selected={selected}
      status={backlog.state}
      statusColor={selected ? 'white' : backlogStateColor(backlog.state)}
      mode={backlog.executionMode}
      id={backlog.id}
      title={normalizeRowText(backlog.title)}
    />
  );
}
