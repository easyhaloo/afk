import React from 'react';
import { renderToString } from 'ink';
import { describe, expect, it, vi } from 'vitest';
import type { BacklogItem } from '../../domain/backlog/index';
import { BoardView } from './board/BoardView';
import { loadBacklogViewModels } from './data/backlog-adapter';

describe('backlog board integration', () => {
  it('renders provider-backed canonical data without claiming work', async () => {
    const item: BacklogItem = {
      id: '42',
      title: 'Verify release',
      description: 'Run acceptance checks.',
      parentId: '10',
      dependsOn: ['7'],
      state: 'verification',
      executionMode: 'hitl',
      tags: ['team:api'],
      branchName: 'afk/backlog-42',
      providerRef: 'github:org/repo#42',
      webUrl: 'https://example.test/42',
    };
    const claim = vi.fn();
    const transition = vi.fn();
    const addTag = vi.fn();
    const backlogs = await loadBacklogViewModels({
      backlog: { list: vi.fn(async () => [item]), claim, transition, addTag },
    } as never);

    const output = renderToString(
      <BoardView backlogs={backlogs} selectedIndex={0} scrollOffset={0} viewportHeight={10} width={120} />,
    );

    expect(output).toContain('flow');
    expect(output).toContain('◌');
    expect(output).toContain('◇');
    expect(output).toContain('#42');
    expect(output).toContain('Verify release');
    expect(claim).not.toHaveBeenCalled();
    expect(transition).not.toHaveBeenCalled();
    expect(addTag).not.toHaveBeenCalled();
  });
});
