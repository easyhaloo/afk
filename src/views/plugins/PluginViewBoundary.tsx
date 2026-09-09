import React from 'react';
import { Box, Text } from 'ink';
import type { LoadedTuiView, TuiPluginContext } from './types';

interface Props {
  view: LoadedTuiView;
  context: TuiPluginContext;
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, ' ').trim() || 'unknown plugin error';
}

export function PluginViewBoundary({ view, context }: Props) {
  try {
    return <>{view.render(context)}</>;
  } catch (error) {
    return (
      <Box flexDirection="column" paddingX={2} paddingY={1}>
        <Text color="red">Plugin failed: {view.pluginId}</Text>
        <Text dimColor>{errorMessage(error)}</Text>
      </Box>
    );
  }
}
