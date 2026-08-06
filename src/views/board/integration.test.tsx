import React from 'react';
import { renderToString } from 'ink';
import { describe, expect, it, vi } from 'vitest';
import type { BacklogItem } from '../../lib/core/backlog';
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

    expect(output).toContain('verification');
    expect(output).toContain('hitl');
    expect(output).toContain('backlog 42');
    expect(claim).not.toHaveBeenCalled();
    expect(transition).not.toHaveBeenCalled();
    expect(addTag).not.toHaveBeenCalled();
  });

  it('filters backlogs by id (case-insensitive)', async () => {
    const items: BacklogItem[] = [
      { id: '100', title: 'Alpha', description: 'First item', parentId: undefined, dependsOn: [], state: 'pending', executionMode: 'batch', tags: [], branchName: 'main', providerRef: 'ref1', webUrl: undefined },
      { id: '200', title: 'Beta', description: 'Second item', parentId: undefined, dependsOn: [], state: 'pending', executionMode: 'batch', tags: [], branchName: 'main', providerRef: 'ref2', webUrl: undefined },
    ];
    const backlogs = await loadBacklogViewModels({
      backlog: { list: vi.fn(async () => items), claim: vi.fn(), transition: vi.fn(), addTag: vi.fn() },
    } as never);

    // Filter by id '100'
    const filtered = backlogs.filter(b => String(b.id).toLowerCase().includes('100'));
    const output = renderToString(
      <BoardView backlogs={filtered} selectedIndex={0} scrollOffset={0} viewportHeight={10} width={120} />,
    );
    expect(output).toContain('Alpha');
    expect(output).not.toContain('Beta');
  });

  it('filters backlogs by title (case-insensitive)', async () => {
    const items: BacklogItem[] = [
      { id: '1', title: 'Alpha Task', description: 'First', parentId: undefined, dependsOn: [], state: 'pending', executionMode: 'batch', tags: [], branchName: 'main', providerRef: 'ref1', webUrl: undefined },
      { id: '2', title: 'Beta Task', description: 'Second', parentId: undefined, dependsOn: [], state: 'pending', executionMode: 'batch', tags: [], branchName: 'main', providerRef: 'ref2', webUrl: undefined },
    ];
    const backlogs = await loadBacklogViewModels({
      backlog: { list: vi.fn(async () => items), claim: vi.fn(), transition: vi.fn(), addTag: vi.fn() },
    } as never);

    const filtered = backlogs.filter(b => b.title.toLowerCase().includes('alpha'));
    const output = renderToString(
      <BoardView backlogs={filtered} selectedIndex={0} scrollOffset={0} viewportHeight={10} width={120} />,
    );
    expect(output).toContain('Alpha');
    expect(output).not.toContain('Beta');
  });

  it('filters backlogs by description (case-insensitive)', async () => {
    const items: BacklogItem[] = [
      { id: '1', title: 'First', description: 'Alpha description here', parentId: undefined, dependsOn: [], state: 'pending', executionMode: 'batch', tags: [], branchName: 'main', providerRef: 'ref1', webUrl: undefined },
      { id: '2', title: 'Second', description: 'Beta description here', parentId: undefined, dependsOn: [], state: 'pending', executionMode: 'batch', tags: [], branchName: 'main', providerRef: 'ref2', webUrl: undefined },
    ];
    const backlogs = await loadBacklogViewModels({
      backlog: { list: vi.fn(async () => items), claim: vi.fn(), transition: vi.fn(), addTag: vi.fn() },
    } as never);

    const filtered = backlogs.filter(b => b.description?.toLowerCase().includes('alpha'));
    const output = renderToString(
      <BoardView backlogs={filtered} selectedIndex={0} scrollOffset={0} viewportHeight={10} width={120} />,
    );
    expect(output).toContain('First');
    expect(output).not.toContain('Second');
  });
});
