import React from 'react';
import { Box, renderToString } from 'ink';
import { describe, expect, it } from 'vitest';
import { HelpDialog } from './HelpDialog';

describe('HelpDialog', () => {
  it('documents task runtime actions without provider open', () => {
    const output = renderToString(<Box height={24}><HelpDialog /></Box>);

    expect(output).toContain('1 - tasks');
    expect(output).toContain('2 - backlogs');
    expect(output).toContain('3 - projects');
    expect(output).toContain('4 - board');
    expect(output).toContain('Enter - detail');
    expect(output).toContain('r - refresh');
    expect(output).toContain('a - attach interactive task');
    expect(output).toContain('o - open task diagnostics');
    expect(output).not.toContain('o - open provider URL');
    expect(output).not.toContain('sessions');
    expect(output).not.toContain('kill');
    expect(output).not.toContain('transition');
  });

  it('shows provider actions for a backlog list', () => {
    const output = renderToString(<Box height={24}><HelpDialog view="backlogs" /></Box>);

    expect(output).toContain('r - refresh');
    expect(output).toContain('o - open provider URL');
    expect(output).not.toContain('a - attach selected task');
    expect(output).not.toContain('b/ESC back');
  });

  it('shows only back navigation for task details', () => {
    const output = renderToString(<Box height={24}><HelpDialog view="tasks" detail /></Box>);

    expect(output).toContain('b/ESC back');
    expect(output).not.toContain('↑↓ - move');
    expect(output).not.toContain('g/G - top/bottom');
    expect(output).not.toContain('Enter - detail');
    expect(output).not.toContain('r - refresh');
    expect(output).not.toContain('o - open provider URL');
    expect(output).not.toContain('a - attach selected task');
  });
});
