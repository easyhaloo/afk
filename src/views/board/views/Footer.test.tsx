import React from 'react';
import { renderToString } from 'ink';
import { describe, expect, it } from 'vitest';
import { Footer, fitFooterPath } from './Footer';

describe('Footer', () => {
  it('shows detail-only shortcuts', () => {
    const output = renderToString(<Footer view="backlogs" detail search={false} canOpen />);

    expect(output).toContain('b/ESC back');
    expect(output).toContain('o open');
    expect(output).toContain('? help');
    expect(output).not.toContain('↑↓');
  });

  it('advertises diagnostic opening and interactive attach for task details', () => {
    const output = renderToString(<Footer view="tasks" detail search={false} canOpen canAttach />);

    expect(output).toContain('b/ESC back');
    expect(output).toContain('a attach');
    expect(output).toContain('o open');
  });

  it('shows list navigation and search shortcuts', () => {
    const output = renderToString(<Footer view="projects" detail={false} search={false} canOpen />);

    expect(output).toContain('↑↓ move');
    expect(output).toContain('enter detail');
    expect(output).toContain('o open');
    expect(output).toContain('/ search');
    expect(output).toContain('? help');
    expect(output).toContain('ctrl+d debug');
  });

  it('shows lane-aware navigation on the board', () => {
    const output = renderToString(<Footer view="board" detail={false} search={false} />);

    expect(output).toContain('←→ lanes');
    expect(output).toContain('↑↓ cards');
    expect(output).toContain('enter detail');
  });

  it('replaces the search hint while search mode is active', () => {
    const output = renderToString(<Footer view="projects" detail={false} search canOpen />);

    expect(output).toContain('esc finish search');
    expect(output).not.toContain('/ search');
    expect(output).not.toContain('↑↓');
    expect(output).not.toContain('enter detail');
    expect(output).not.toContain('o open');
  });

  it('adds diagnostic and interactive attach shortcuts to the task list', () => {
    const output = renderToString(<Footer view="tasks" detail={false} search={false} canOpen />);

    expect(output).toContain('o open');
    expect(output).toContain('ctrl+d debug');
    expect(output).not.toContain('a attach');
  });

  it('omits capability-specific actions when the selected item cannot execute them', () => {
    const output = renderToString(<Footer view="tasks" detail search={false} />);

    expect(output).not.toContain('o open');
    expect(output).not.toContain('a attach');
  });

  it('fits long path labels within the available footer width', () => {
    const shortcuts = '↑↓ move · enter detail · o open · / search · ? help';
    const path = '/a/very/long/project/path/that/should/not/wrap (feature/large-change)';

    expect(fitFooterPath(path, 80, shortcuts).length).toBeLessThanOrEqual(20);
    expect(fitFooterPath(path, 100, shortcuts).length).toBeLessThanOrEqual(40);
  });
});
