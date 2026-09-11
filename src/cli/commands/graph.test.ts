import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { generateWorkflowGraph } from '../../application/visualizations/workflow-graph';
import { writeGraphCache } from '../../application/visualizations/graph-cache';

const projects: string[] = [];
afterEach(async () => { await Promise.all(projects.splice(0).map((project) => rm(project, { recursive: true, force: true }))); });

async function projectWithTemplate(content: string): Promise<string> {
  const project = await mkdtemp(join(tmpdir(), 'afk-graph-'));
  projects.push(project);
  await writeFile(join(await (async () => { const { mkdir } = await import('node:fs/promises'); const path = join(project, '.afk', 'workflows'); await mkdir(path, { recursive: true }); return path; })(), 'review.yml'), content);
  return project;
}

describe('workflow graph application', () => {
  it('generates JSON-safe graph output and hash-addressed cache files', async () => {
    const project = await projectWithTemplate('name: review\nversion: 1\nsteps:\n  - id: implement\n    role: implementer\n    prompt: implement\n  - id: review\n    role: reviewer\n    prompt: review\n    dependsOn: [implement]\n');
    const result = await generateWorkflowGraph({ projectRoot: project, template: 'review', generatedAt: '2026-01-01T00:00:00.000Z' });
    expect(result.snapshot.nodes).toHaveLength(2);
    const cache = await writeGraphCache(project, result, 'json');
    expect(cache.directory).toContain(join('.afk', 'cache', 'archify', 'workflow', 'review'));
    expect(JSON.parse(await readFile(cache.graphPath, 'utf8')).nodes).toHaveLength(2);
    expect(JSON.parse(await readFile(cache.receiptPath, 'utf8')).inputHash).toBe(result.receipt.inputHash);
  });
});
