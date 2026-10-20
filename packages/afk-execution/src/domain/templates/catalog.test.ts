import { describe, expect, it, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TemplateCatalog } from './catalog.js';
import { TemplateError, type WorkflowTemplate } from './types.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function root(): Promise<string> {
  const created = await mkdtemp(join(tmpdir(), 'afk-catalog-'));
  roots.push(created);
  return created;
}

/** Write a template file into `<root>/.afk/workflows/<name>.yml`. */
async function writeTemplate(rootDir: string, name: string, stepId: string): Promise<string> {
  const dir = join(rootDir, '.afk', 'workflows');
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${name}.yml`);
  await writeFile(path, `name: ${name}\nversion: 1\nsteps:\n  - id: ${stepId}\n    role: implementer\n    prompt: hi\n`);
  return path;
}

const custom = (name: string, stepId: string): WorkflowTemplate => ({
  name,
  version: 1,
  steps: [{ id: stepId, role: 'implementer', prompt: 'hi' }],
});

describe('TemplateCatalog — the single entry point', () => {
  it('answers for a template, for a plan and for a step', async () => {
    const catalog = new TemplateCatalog({ projectRoot: await root(), homeDir: await root() });

    // The template.
    const template = await catalog.load('simple-loop');
    expect(template.name).toBe('simple-loop');

    // The plan, compiled from the same template.
    const plan = catalog.compile(template);
    expect(plan.templateName).toBe('simple-loop');
    expect(plan.groups[0]?.steps.map(step => step.id)).toEqual(['run']);

    // The step, named out of the plan.
    const step = catalog.selectStep(plan, { kind: 'agent' });
    expect(step).toMatchObject({ id: 'run', kind: 'agent' });
  });

  it('names the step a caller asks for without the caller reading the groups', () => {
    const catalog = new TemplateCatalog();
    const plan = catalog.compile({
      name: 'two-steps', version: 1,
      steps: [
        { id: 'build', role: 'implementer', phase: 'implementation', completionKind: 'task', prompt: 'build' },
        { id: 'check', role: 'verifier', phase: 'verification', completionKind: 'ac', prompt: 'check', dependsOn: ['build'] },
      ],
    });

    expect(catalog.selectStep(plan, { completionKind: 'ac' })).toMatchObject({ id: 'check' });
    expect(catalog.selectStep(plan, { kind: 'system' })).toBeUndefined();
  });

  it('falls back to the built-in templates', async () => {
    const catalog = new TemplateCatalog({ projectRoot: await root(), homeDir: await root() });

    const loaded = await catalog.loadWithSource('issue-implementation');

    expect(loaded.source).toBe('builtin');
    expect(loaded.template.steps.map(step => step.id)).toEqual(['implement', 'verify-ac', 'publish', 'queue-qa']);
  });

  it('lets a project template win over a built-in', async () => {
    const projectRoot = await root();
    const homeDir = await root();
    await writeTemplate(projectRoot, 'simple-loop', 'from-project');
    const catalog = new TemplateCatalog({ projectRoot, homeDir });

    const loaded = await catalog.loadWithSource('simple-loop');

    expect(loaded.source).toBe('project');
    expect(loaded.template.steps[0]?.id).toBe('from-project');
  });
});

describe('TemplateCatalog — the search priority chain', () => {
  it('prefers the CLI path over the project', async () => {
    const projectRoot = await root();
    const homeDir = await root();
    await writeTemplate(projectRoot, 'chain', 'from-project');
    const cliPath = join(await root(), 'chain.yml');
    await writeFile(cliPath, 'name: chain\nversion: 1\nsteps:\n  - id: from-cli\n    role: implementer\n    prompt: hi\n');
    const catalog = new TemplateCatalog({ projectRoot, homeDir });

    const loaded = await catalog.loadWithSource(cliPath);

    expect(loaded.source).toBe('cli');
    expect(loaded.template.steps[0]?.id).toBe('from-cli');
  });

  it('prefers the project over the user', async () => {
    const projectRoot = await root();
    const homeDir = await root();
    await writeTemplate(projectRoot, 'chain', 'from-project');
    await writeTemplate(homeDir, 'chain', 'from-user');
    const catalog = new TemplateCatalog({ projectRoot, homeDir });

    const loaded = await catalog.loadWithSource('chain');

    expect(loaded.source).toBe('project');
    expect(loaded.template.steps[0]?.id).toBe('from-project');
  });

  it('prefers the user over the built-in', async () => {
    const projectRoot = await root();
    const homeDir = await root();
    await writeTemplate(homeDir, 'simple-loop', 'from-user');
    const catalog = new TemplateCatalog({ projectRoot, homeDir });

    const loaded = await catalog.loadWithSource('simple-loop');

    expect(loaded.source).toBe('user');
    expect(loaded.template.steps[0]?.id).toBe('from-user');
  });

  it('raises TemplateError when nothing matches and no template is registered', async () => {
    const catalog = new TemplateCatalog({ projectRoot: await root(), homeDir: await root() });

    await expect(catalog.load('nonexistent')).rejects.toThrow(/not found/);
  });

  it('raises TemplateError with the path when a file does not parse', async () => {
    const projectRoot = await root();
    const homeDir = await root();
    const dir = join(projectRoot, '.afk', 'workflows');
    await mkdir(dir, { recursive: true });
    const path = join(dir, 'broken.yml');
    await writeFile(path, 'name: broken\nversion: 1\nsteps: [oops\n');
    const catalog = new TemplateCatalog({ projectRoot, homeDir });

    const failure = catalog.load('broken');

    await expect(failure).rejects.toThrow(TemplateError);
    await expect(failure).rejects.toThrow(/broken\.yml/);
  });
});

describe('TemplateCatalog — no process-global state', () => {
  it('does not let one catalogue see another catalogue\'s registrations', async () => {
    const first = new TemplateCatalog();
    const second = new TemplateCatalog();

    first.register(custom('only-in-first', 'only'));

    expect(first.find('only-in-first')).toBeDefined();
    expect(second.find('only-in-first')).toBeUndefined();
    await expect(second.load('only-in-first')).rejects.toThrow(/not found/);
  });

  it('registers the templates it is constructed with', () => {
    const catalog = new TemplateCatalog({ templates: [custom('given-at-construction', 'given')] });

    expect(catalog.find('given-at-construction')).toBeDefined();
    expect(catalog.names()).toContain('given-at-construction');
  });
});
