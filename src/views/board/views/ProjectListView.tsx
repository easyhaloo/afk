import React from 'react';
import { Project } from '../../../types/board';
import { ListView, normalizeRowText } from './ListView';
import { truncate } from '../utils';
import { OperationalRow } from './OperationalRow';
import { getBranchColor, getProjectPlatformColor, getProjectPlatformIcon } from './display';

export { getBranchColor, getProjectPlatformIcon } from './display';

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
      getKey={(p) => `${p.platform || 'gitlab'}:${p.id}`}
      render={(project, _index, isSelected) => {
        const namespace = normalizeRowText(project.namespace?.name || '') || '–';
        const branch = normalizeRowText(project.default_branch || '') || '–';
        const platform = project.platform || 'gitlab';
        const description = project.description
          ? truncate(normalizeRowText(project.description), 50)
          : '–';
        return (
          <OperationalRow
            width={width}
            selected={isSelected}
            status={`project_${platform}`}
            statusColor={isSelected ? 'white' : getProjectPlatformColor(platform)}
            mode=""
            id={project.id}
            title={normalizeRowText(project.name) || 'untitled project'}
            summaryParts={[
              { text: `${namespace} · ` },
              { text: branch, color: getBranchColor(branch, project.default_branch) },
              { text: ` · ${description}` },
            ]}
          />
        );
      }}
    />
  );
}
