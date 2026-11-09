import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { generateWorkflowGraph } from '@afk/runtime/application/visualizations/workflow-graph';
import { writeGraphCache } from '@afk/runtime/application/visualizations/graph-cache';
import { workspaceStateDirectory, workspaceDataDirectory } from '@afk/runtime/infrastructure/workspace';
import { PluginRuntime } from '@afk/runtime/plugin-sdk';

const projects: string[] = [];
afterEach(async () => { await Promise.all(projects.splice(0).map((project) => rm(project, { recursive: true, force: true }))); });

async function projectWithTemplate(content: string): Promise<string> {
  const project = await mkdtemp(join(tmpdir(), 'afk-graph-'));
  projects.push(project);
  const directory = join(workspaceStateDirectory(), 'workflows');
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'review.yml'), content);
  return project;
}

describe('workflow graph application', () => {
  it('uses the same registered plugin template as execution and rejects it after plugin disposal', async () => {
    const project = await mkdtemp(join(tmpdir(), 'plugin-template-graph-'));
    projects.push(project);
    const plugins = new PluginRuntime();
    await plugins.activate({ manifest: { id: 'workflow.graph-review', version: '1.0.0', apiVersion: 1, provides: ['workflow.template'], trusted: true },
      activate(context) { context.registerWorkflowTemplate({ name: 'plugin-graph-review', version: 1, steps: [{ id: 'review', kind: 'agent', role: 'reviewer', prompt: 'Review' }] }); } });
    try {
      const result = await generateWorkflowGraph({ projectRoot: project, template: 'plugin-graph-review', plugins });
      expect(result.template.source).toBe('plugin');
      expect(result.snapshot.nodes).toHaveLength(1);
      await plugins.dispose('workflow.graph-review');
      await expect(generateWorkflowGraph({ projectRoot: project, template: 'plugin-graph-review', plugins })).rejects.toThrow('not found');
    } finally { await plugins.dispose(); }
  });
  it('generates JSON-safe graph output and hash-addressed cache files', async () => {
    const project = await projectWithTemplate('name: review\nversion: 1\nsteps:\n  - id: implement\n    role: implementer\n    prompt: implement\n  - id: review\n    role: reviewer\n    prompt: review\n    dependsOn: [implement]\n');
    const result = await generateWorkflowGraph({ projectRoot: project, template: 'review', generatedAt: '2026-01-01T00:00:00.000Z' });
    expect(result.snapshot.nodes).toHaveLength(2);
    const cache = await writeGraphCache(project, result, 'json');
    expect(cache.directory).toContain(join(workspaceDataDirectory(project), 'cache', 'archify', 'workflow', 'review'));
    expect(JSON.parse(await readFile(cache.graphPath, 'utf8')).nodes).toHaveLength(2);
    expect(JSON.parse(await readFile(cache.receiptPath, 'utf8')).inputHash).toBe(result.receipt.inputHash);
    const output = join(workspaceDataDirectory(project), 'cache', 'archify', 'custom');
    expect((await writeGraphCache(project, result, 'json', output)).directory).toBe(output);
    await expect(writeGraphCache(project, result, 'json', `${output}/../../../../outside`)).rejects.toThrow('--output');
    await expect(writeGraphCache(project, result, 'json', '../outside')).rejects.toThrow('--output');
  });
});
