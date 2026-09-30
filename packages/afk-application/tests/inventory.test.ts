import { describe, expect, it } from 'vitest';
import { listWorkItems, type WorkItemInventoryPort } from '../src/index.js';

const item = (id: string, title: string, state: 'ready' | 'done' = 'ready') => ({
  id,
  title,
  state,
  mode: 'autonomous' as const,
  lineage: { dependsOn: [] },
  revision: 0,
});

describe('listWorkItems', () => {
  it('filters and orders core work items while preserving source diagnostics', async () => {
    const inventory: WorkItemInventoryPort = {
      async list() {
        return {
          items: [item('b', 'Beta'), item('a', 'Alpha'), item('c', 'Closed', 'done')],
          diagnostics: [{ code: 'partial', message: 'one project was unavailable', retryable: true }],
          complete: false,
        };
      },
    };

    await expect(listWorkItems({ state: 'ready', text: 'alp' }, { inventory })).resolves.toEqual({
      items: [item('a', 'Alpha')],
      diagnostics: [{ code: 'partial', message: 'one project was unavailable', retryable: true }],
      complete: false,
    });
  });
});
