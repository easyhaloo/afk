import React from 'react';
import { Text, renderToString } from 'ink';
import { describe, expect, it, vi } from 'vitest';
import { PluginViewBoundary } from './PluginViewBoundary';
import type { LoadedTuiView, TuiPluginContext } from './types';

const context: TuiPluginContext = {
  cwd: '/tmp/plugin-test',
  workspace: '/tmp/workspace',
  notify: () => {},
};

function view(render: LoadedTuiView['render']): LoadedTuiView {
  return {
    id: 'plugin:example:status',
    pluginId: 'example',
    title: 'Status',
    shortcut: 'z',
    render,
  };
}

describe('PluginViewBoundary', () => {
  it('renders the plugin view with the narrow context', () => {
    const renderPlugin = vi.fn((pluginContext: TuiPluginContext) => <Text>{pluginContext.cwd}</Text>);
    const output = renderToString(<PluginViewBoundary view={view(renderPlugin)} context={context} />);

    expect(output).toContain('/tmp/plugin-test');
    expect(renderPlugin).toHaveBeenCalledWith(context);
  });

  it('renders an error panel instead of propagating plugin render failures', () => {
    const renderPlugin = () => { throw new Error('plugin exploded'); };
    const output = renderToString(<PluginViewBoundary view={view(renderPlugin)} context={context} />);

    expect(output).toContain('Plugin failed: example');
    expect(output).toContain('plugin exploded');
  });
});
