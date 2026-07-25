import React from 'react';
import { Box, Text } from 'ink';
import { Project } from '../../../types/dashboard';
import { ListView } from './ListView';

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
            minHeight={3}
            overflow="hidden"
            flexDirection="column"
            borderStyle={isSelected ? 'round' : undefined}
            borderColor={isSelected ? 'white' : undefined}
            paddingX={1}
          >
            <Box>
              <Text color={color}>{isSelected ? '◉' : '▸'} </Text>
              <Text color={color} bold> #{project.id} </Text>
              <Text color={color}>{project.name}</Text>
            </Box>
            <Box paddingLeft={2}>
              <Text dimColor>  ─ {project.description ? truncate(project.description, 50) : '…'}</Text>
            </Box>
          </Box>
        );
      }}
    />
  );
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max - 3) + '…';
}
