import React from 'react';
import { renderToString } from 'ink';
import { describe, expect, it } from 'vitest';
import { Footer, fitFooterPath } from './Footer';

describe('Footer', () => {
  it('shows detail-only shortcuts', () => {
    const output = renderToString(<Footer view="backlogs" detail search={false} />);

    expect(output).toContain('b/ESC back');
    expect(output).toContain('o open');
    expect(output).toContain('? help');
    expect(output).not.toContain('↑↓');
  });

  it('does not advertise browser open for task details', () => {
    const output = renderToString(<Footer view="tasks" detail search={false} />);

    expect(output).toContain('b/ESC back');
    expect(output).toContain('a attach');
    expect(output).not.toContain('o open');
  });

  it('shows list navigation and search shortcuts', () => {
    const output = renderToString(<Footer view="projects" detail={false} search={false} />);

    expect(output).toContain('↑↓ move');
    expect(output).toContain('enter detail');
    expect(output).toContain('o open');
    expect(output).toContain('/ search');
    expect(output).toContain('? help');
  });

  it('replaces the search hint while search mode is active', () => {
    const output = renderToString(<Footer view="projects" detail={false} search />);

    expect(output).toContain('esc finish search');
    expect(output).not.toContain('/ search');
  });

  it('adds attach to the task list shortcuts', () => {
    const output = renderToString(<Footer view="tasks" detail={false} search={false} />);

    expect(output).toContain('a attach');
    expect(output).not.toContain('o open');
  });

  it('fits long path labels within the available footer width', () => {
    const shortcuts = '↑↓ move · enter detail · o open · / search · ? help';
    const path = '/a/very/long/project/path/that/should/not/wrap (feature/large-change)';

    expect(fitFooterPath(path, 80, shortcuts).length).toBeLessThanOrEqual(20);
    expect(fitFooterPath(path, 100, shortcuts).length).toBeLessThanOrEqual(40);
  });
});
