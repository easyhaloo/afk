import React from 'react';
import { renderToString } from 'ink';
import { describe, expect, it } from 'vitest';
import { DetailScreen } from './DetailScreen';
import type { BacklogViewModel } from '../data/backlog-adapter';

const backlog: BacklogViewModel = {
  id: 'BL-42',
  title: 'Ship the operational detail view',
  description: '## Acceptance\n\n- **compact** metadata',
  state: 'ready',
  executionMode: 'afk',
  parentId: 'BL-1',
  dependsOn: ['BL-7'],
  tags: ['tui', 'ops'],
  branchName: 'feature/detail',
  providerRef: 'gitlab#42',
  webUrl: 'https://gitlab.example/BL-42',
};

describe('DetailScreen', () => {
  it('renders grouped backlog metadata and markdown description', () => {
    const output = renderToString(
      <DetailScreen item={backlog} view="backlogs" height={24} width={80} />,
    );

    expect(output).toContain('Ship the operational detail view');
    expect(output).toContain('state · ○');
    expect(output).toContain('executionMode · ⚙');
    expect(output).not.toContain('state · ready');
    expect(output).not.toContain('executionMode · afk');
    expect(output).toContain('parent · BL-1');
    expect(output).toContain('dependsOn · BL-7');
    expect(output).toContain('tags · tui, ops');
    expect(output).toContain('branch · feature/detail');
    expect(output).toContain('providerRef · gitlab#42');
    expect(output).toContain('provider URL · https://gitlab.example/BL-42');
    expect(output).toContain('Acceptance');
    expect(output).toContain('compact');
    expect(output).not.toContain('**');
    expect(output).not.toContain('┌');
    expect(output).not.toContain('└');
    expect(output.indexOf('identity')).toBeLessThan(output.indexOf('relationships'));
    expect(output.indexOf('relationships')).toBeLessThan(output.indexOf('description'));
    expect(output.indexOf('description')).toBeLessThan(output.indexOf('provider URL'));
  });

  it('renders task runtime fields in canonical order without owning a footer', () => {
    const task = { iid: '7', runId: 'run-7', title: 'Run task', status: 'active' as const, phase: 'implementing' as const, executionMode: 'batch' as const, sandboxProvider: 'local', agentProvider: 'claude-code', branch: 'main', progress: '50%', worktree: '/tmp/afk-7', diagnosticPath: '/tmp/afk-7/.afk/runs/run-7' };
    const output = renderToString(<DetailScreen item={task} view="tasks" height={24} width={80} />);

    expect(output.indexOf('phase · implementing')).toBeLessThan(output.indexOf('status · ●'));
    expect(output.indexOf('status · ●')).toBeLessThan(output.indexOf('execution mode · ⚙'));
    expect(output.indexOf('execution mode · ⚙')).toBeLessThan(output.indexOf('worktree · /tmp/afk-7'));
    expect(output).not.toContain('status · active');
    expect(output).not.toContain('execution mode · batch');
    expect(output.indexOf('worktree · /tmp/afk-7')).toBeLessThan(output.indexOf('branch · main'));
    expect(output.indexOf('branch · main')).toBeLessThan(output.indexOf('progress · 50%'));
    expect(output).toContain('diagnostics · /tmp/afk-7/.afk/runs/run-7');
    expect(output).not.toContain('b/ESC back');
  });
});
