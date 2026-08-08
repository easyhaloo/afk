import React from 'react';
import { renderToString } from 'ink';
import { describe, expect, it } from 'vitest';
import { Header } from './Header';

describe('Header', () => {
  it('marks the active Backlogs subview and appends its count', () => {
    const output = renderToString(
      <Header view="backlogs" tasksCount={1} backlogsCount={4} projectsCount={2} />,
    );

    expect(output).toContain('1 tasks');
    expect(output).toContain('2 backlogs 4');
    expect(output).toContain('3 projects');
    expect(output).toContain('4 board');
  });

  it('appends the project count only to the active Projects label', () => {
    const output = renderToString(
      <Header view="projects" tasksCount={1} backlogsCount={4} projectsCount={2} />,
    );

    expect(output).toContain('3 projects 2');
    expect(output).not.toContain('1 tasks 1');
  });

  it('keeps board chrome to one row because flow states belong to the board', () => {
    const output = renderToString(
      <Header view="board" tasksCount={1} backlogsCount={4} projectsCount={2} width={120} />,
    );

    expect(output.trimEnd().split('\n')).toHaveLength(1);
    expect(output).toContain('4 board 4');
    expect(output).not.toContain('ready');
  });
});
