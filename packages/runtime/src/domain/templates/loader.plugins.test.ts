import { afterEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TemplateLoader } from './loader.js';
import type { WorkflowTemplate } from './types.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });

describe('plugin template selection', () => {
  it('selects a plugin template and stops resolving it after removal', async () => {
    const homeDir = await fs.mkdtemp(join(tmpdir(), 'template-plugin-'));
    roots.push(homeDir);
    let template: WorkflowTemplate | undefined = { name: 'plugin-review', version: 1, steps: [{ id: 'review', kind: 'agent', role: 'reviewer', prompt: 'Review this task' }] };
    const loader = new TemplateLoader({ homeDir, getPluginTemplate: () => template });
    expect(await loader.loadWithSource('plugin-review')).toMatchObject({ source: 'plugin', template });
    template = undefined;
    await expect(loader.load('plugin-review')).rejects.toThrow('not found');
  });

  it('keeps user files ahead of plugin templates and rejects unresolved prompt paths', async () => {
    const homeDir = await fs.mkdtemp(join(tmpdir(), 'template-plugin-'));
    roots.push(homeDir);
    const template: WorkflowTemplate = { name: 'plugin-review', version: 1, steps: [{ id: 'review', kind: 'agent', role: 'reviewer', prompt: { file: 'relative.md' } }] };
    const loader = new TemplateLoader({ homeDir, getPluginTemplate: () => template });
    await expect(loader.load('plugin-review')).rejects.toThrow('absolute paths');
    const directory = join(homeDir, '.afk', 'workflows');
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(join(directory, 'plugin-review.yml'), JSON.stringify({ ...template, steps: [{ ...template.steps[0], prompt: 'User review instruction' }] }));
    expect(await loader.loadWithSource('plugin-review')).toMatchObject({ source: 'user', template: { steps: [{ prompt: 'User review instruction' }] } });
  });
});
