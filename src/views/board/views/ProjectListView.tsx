import React from 'react';
import { Project } from '../../../types/board';
import { ListView, normalizeRowText } from './ListView';
import { truncate, truncateByVisualWidth } from '../utils';
import { OperationalRow } from './OperationalRow';

interface Props {
  projects: Project[];
  selected: number;
  scrollOffset: number;
  viewportHeight: number;
  width?: number;
}

export function ProjectListView({ projects, selected, scrollOffset, viewportHeight, width: requestedWidth }: Props) {
  const width = requestedWidth || process.stdout.columns || 80;
  return (
    <ListView
      items={projects}
      selected={selected}
      scrollOffset={scrollOffset}
      viewportHeight={viewportHeight}
      width={width}
      emptyMessage="ℹ  no projects"
      getKey={(p) => p.id}
      render={(project, _index, isSelected) => {
        const namespace = normalizeRowText(project.namespace?.name || '') || '–';
        const branch = normalizeRowText(project.default_branch || '') || '–';
        const mode = truncateByVisualWidth(branch, 16);
        const description = project.description
          ? truncate(normalizeRowText(project.description), 50)
          : '–';
        return (
          <OperationalRow
            width={width}
            selected={isSelected}
            status="project"
            statusColor={isSelected ? 'white' : 'gray'}
            mode={mode}
            id={project.id}
            title={normalizeRowText(project.name) || 'untitled project'}
            summary={`${namespace} · ${branch} · ${description}`}
          />
        );
      }}
    />
  );
}
