import React from 'react';
import { Box, Text } from 'ink';
import { Project } from '../../../types/dashboard';
import { ListView } from './ListView';
import { truncate } from '../utils';

interface Props {
  projects: Project[];
  selected: number;
  scrollOffset: number;
  viewportHeight: number;
}

export function ProjectListView({ projects, selected, scrollOffset, viewportHeight }: Props) {
  return (
    <ListView
      items={projects}
      selected={selected}
      scrollOffset={scrollOffset}
      viewportHeight={viewportHeight}
      emptyMessage="ℹ  no projects"
      getKey={(p) => p.id}
      render={(project, index, isSelected) => {
        const color = isSelected ? 'white' : 'gray';
        return (
          <Box
            key={project.id}
            width="100%"
            overflow="hidden"
            flexDirection="row"
            borderStyle={isSelected ? 'round' : undefined}
            borderColor={isSelected ? 'white' : undefined}
            paddingX={1}
          >
            <Text color={color}>{isSelected ? '◉' : '▸'} </Text>
            <Text color={color} bold> #{project.id} </Text>
            <Text color={color}>{project.name}</Text>
            <Text dimColor>  ─ {project.description ? truncate(project.description, 50) : '…'}</Text>
          </Box>
        );
      }}
    />
  );
}
