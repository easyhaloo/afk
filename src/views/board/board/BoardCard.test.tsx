import React from 'react';
import { renderToString } from 'ink';
import { describe, expect, it } from 'vitest';
import type { BacklogViewModel } from '../data/backlog-adapter';
import { BoardCard } from './BoardCard';
import { BoardLane } from './BoardLane';

const backlog: BacklogViewModel = {
  id: '42',
  title: 'Render a pipeline lane card with a readable title',
  description: 'hidden description',
  state: 'verification',
  executionMode: 'hitl',
  parentId: '10',
  dependsOn: ['7'],
  tags: ['team:tui'],
  branchName: 'afk/backlog-42',
  providerRef: 'github:org/repo#42',
  webUrl: 'https://example.test/42',
};

describe('BoardCard', () => {
  it('prioritizes phase and progress before the title at narrow widths', () => {
    const output = renderToString(
      <BoardCard backlog={{ ...backlog, phase: 'verifying', progress: '50%' }} selected width={28} />,
    );

    expect(output).toContain('verifying');
    expect(output).toContain('50%');
  });

  it('shows backlog lifecycle and runtime status independently', () => {
    const output = renderToString(<BoardCard backlog={{ ...backlog, state: 'blocked', runStatus: 'stale', phase: 'verifying', progress: '50%' }} selected width={100} />);

    expect(output).toContain('blocked');
    expect(output).toContain('stale');
    expect(output).toContain('verifying');
    expect(output).toContain('50%');
  });

  it('renders only identity, mode, and title on the card', () => {
    const output = renderToString(<BoardCard backlog={backlog} selected width={80} />);

    expect(output).toContain('#42');
    expect(output).toContain('◇');
    expect(output).not.toContain('p:10');
    expect(output).not.toContain('d:1');
    expect(output).not.toContain(backlog.description);
  });
});

describe('BoardLane', () => {
  it('clips the card stack to the available lane height', () => {
    const output = renderToString(
      <BoardLane
        label="Verification"
        state="verification"
        items={[
          backlog,
          { ...backlog, id: '43', title: 'Second card', state: 'verification' },
          { ...backlog, id: '44', title: 'Third card', state: 'verification' },
        ]}
        width={48}
        height={5}
        focused
        selectedId="43"
        selectedIndex={1}
      />,
    );

    expect(output).toContain('Verification 3');
    expect(output).toContain('#43');
    expect(output).not.toContain('#44');
  });
});
