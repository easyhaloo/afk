import React from 'react';
import type { BacklogViewModel } from '../data/backlog-adapter';
import { ListView } from './ListView';
import { BacklogRow } from './BacklogRow';

interface Props {
  backlogs: BacklogViewModel[];
  selected: number;
  scrollOffset: number;
  viewportHeight: number;
  width?: number;
}

export function BacklogListView({ backlogs, selected, scrollOffset, viewportHeight, width: requestedWidth }: Props) {
  const width = requestedWidth || process.stdout.columns || 80;
  return (
    <ListView
      items={backlogs}
      selected={selected}
      scrollOffset={scrollOffset}
      viewportHeight={viewportHeight}
      width={width}
      emptyMessage="ℹ  no backlogs"
      getKey={backlog => backlog.id}
      render={(backlog, _index, isCurrent) => <BacklogRow backlog={backlog} selected={isCurrent} width={width} />}
    />
  );
}
