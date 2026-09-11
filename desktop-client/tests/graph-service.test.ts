import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WorkflowGraphService } from '../electron/services/graph-service';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe('WorkflowGraphService', () => {
  it('maps an absent cache to missing without throwing', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'afk-desktop-graph-')); roots.push(root);
    await expect(new WorkflowGraphService().status(root, 'review')).resolves.toMatchObject({ state: 'missing', templateId: 'review' });
  });

  it('preserves a trusted graph when generation fails', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'afk-desktop-graph-')); roots.push(root);
    const cache = path.join(root, '.afk', 'cache', 'archify', 'workflow', 'review', 'abc');
    await mkdir(cache, { recursive: true });
    await writeFile(path.join(cache, 'graph.json'), '{"nodes":[]}');
    await writeFile(path.join(cache, 'receipt.json'), '{"inputHash":"abc"}');
    const result = await new WorkflowGraphService().generate({ workspace: root, templateId: 'review' });
    expect(result.status.state).toBe('rejected');
    expect(result.status.trustedInputHash).toBe('abc');
    expect(result.status.graph).toEqual({ nodes: [] });
  });
});
