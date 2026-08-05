import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { promises as afs } from 'fs';
import { TemplateLoader } from './loader';
import { resolveExecutionPlan, hasCycle } from './resolver';
import { evaluateWhen } from './when-evaluator';
import {
  registerTemplate,
  getTemplate,
  requireTemplate,
  listTemplates,
  planFor,
  _resetTemplateRegistry,
} from './registry';
import { builtinTemplates } from './builtin';
import type { WorkflowTemplate, StepResult } from './types';

describe('Template schema — validation', () => {
  const loader = new TemplateLoader();

  it('rejects templates with no steps', () => {
    expect(() => loader.parseAndValidate(`
name: empty
version: 1
steps: []
`, 'empty')).toThrow(/at least 1/);
  });

  it('rejects invalid branch strategy type', () => {
    expect(() => loader.parseAndValidate(`
name: bad
version: 1
steps:
  - id: only
    role: implementer
    prompt: hi
    branch:
      type: bogus
`, 'bad')).toThrow(/schema validation/);
  });

  it('rejects step id with uppercase characters', () => {
    expect(() => loader.parseAndValidate(`
name: bad-id
version: 1
steps:
  - id: BadId
    role: implementer
    prompt: hi
`, 'bad-id')).toThrow(/kebab-case/);
  });

  it('rejects when clause without equals or notEquals', () => {
    expect(() => loader.parseAndValidate(`
name: bad-when
version: 1
steps:
  - id: a
    role: implementer
    prompt: hi
  - id: b
    role: implementer
    prompt: hi
    dependsOn: [a]
    when:
      step: a
`, 'bad-when')).toThrow(/schema validation/);
  });

  it('accepts a minimal valid template', () => {
    const t = loader.parseAndValidate(`
name: minimal
version: 1
steps:
  - id: only
    role: implementer
    prompt: hi
`, 'minimal');
    expect(t.name).toBe('minimal');
    expect(t.steps.length).toBe(1);
  });
});

describe('Dependency resolver', () => {
  function mkTemplate(steps: Array<{ id: string; dependsOn?: string[] }>): WorkflowTemplate {
    return {
      name: 'test',
      version: 1,
      steps: steps.map(s => ({
        id: s.id,
        role: 'r',
        prompt: 'p',
        dependsOn: s.dependsOn,
      })),
    };
  }

  it('puts independent steps in level 0', () => {
    const t = mkTemplate([{ id: 'a' }, { id: 'b' }]);
    const plan = resolveExecutionPlan(t);
    expect(plan.groups.length).toBe(1);
    expect(plan.groups[0].steps.map(s => s.id)).toEqual(['a', 'b']);
  });

  it('orders dependent steps correctly', () => {
    const t = mkTemplate([{ id: 'a' }, { id: 'b', dependsOn: ['a'] }, { id: 'c', dependsOn: ['b'] }]);
    const plan = resolveExecutionPlan(t);
    expect(plan.groups.map(g => g.steps.map(s => s.id))).toEqual([['a'], ['b'], ['c']]);
  });

  it('groups parallel steps at the same level', () => {
    const t = mkTemplate([
      { id: 'a' },
      { id: 'b' },
      { id: 'c' },
      { id: 'd', dependsOn: ['a', 'b', 'c'] },
    ]);
    const plan = resolveExecutionPlan(t);
    expect(plan.groups[0].steps.map(s => s.id)).toEqual(['a', 'b', 'c']);
    expect(plan.groups[1].steps.map(s => s.id)).toEqual(['d']);
  });

  it('detects cycles', () => {
    const t = mkTemplate([{ id: 'a', dependsOn: ['b'] }, { id: 'b', dependsOn: ['a'] }]);
    expect(() => resolveExecutionPlan(t)).toThrow(/cycle/);
    expect(hasCycle(t)).toBe(true);
  });

  it('detects self-dependency', () => {
    const t = mkTemplate([{ id: 'a', dependsOn: ['a'] }]);
    expect(() => resolveExecutionPlan(t)).toThrow(/itself/);
  });

  it('detects unknown dependsOn reference', () => {
    const t = mkTemplate([{ id: 'a', dependsOn: ['ghost'] }]);
    expect(() => resolveExecutionPlan(t)).toThrow(/unknown step/);
  });

  it('preserves declaration order within a level', () => {
    const t = mkTemplate([{ id: 'z' }, { id: 'a' }, { id: 'm' }]);
    const plan = resolveExecutionPlan(t);
    expect(plan.groups[0].steps.map(s => s.id)).toEqual(['z', 'a', 'm']);
  });
});

describe('When-clause evaluator', () => {
  const results: Record<string, StepResult> = {
    review: {
      stepId: 'review',
      status: 'completed',
      startedAt: 'now',
      completedAt: 'now',
    },
    broken: {
      stepId: 'broken',
      status: 'failed',
      startedAt: 'now',
      completedAt: 'now',
    },
  };

  it('returns true when no clause', () => {
    expect(evaluateWhen(undefined, results)).toBe(true);
  });

  it('returns true when referenced step has not run yet (forward reference)', () => {
    expect(evaluateWhen({ step: 'future', equals: 'completed' }, results)).toBe(true);
  });

  it('matches equals clause', () => {
    expect(evaluateWhen({ step: 'review', equals: 'completed' }, results)).toBe(true);
    expect(evaluateWhen({ step: 'broken', equals: 'completed' }, results)).toBe(false);
  });

  it('matches notEquals clause', () => {
    expect(evaluateWhen({ step: 'review', notEquals: 'failed' }, results)).toBe(true);
    expect(evaluateWhen({ step: 'broken', notEquals: 'failed' }, results)).toBe(false);
  });
});

describe('Builtin templates', () => {
  beforeEach(() => _resetTemplateRegistry());
  afterEach(() => _resetTemplateRegistry());

  it('all builtin templates are registered', () => {
    expect(listTemplates().sort()).toEqual([
      'issue-implementation',
      'parallel-planner',
      'planner-with-review',
      'pre-merge-qa-verification',
      'sequential-review',
      'simple-loop',
    ]);
  });

  it('issue-implementation has 4 steps in dependency order', () => {
    const t = requireTemplate('issue-implementation');
    const plan = resolveExecutionPlan(t);
    expect(plan.groups.map(g => g.steps.map(s => s.id))).toEqual([
      ['implement'],
      ['verify-ac'],
      ['publish'],
      ['queue-qa'],
    ]);
  });

  it('sequential-review fix step is gated on review=failed', () => {
    const t = requireTemplate('sequential-review');
    const plan = resolveExecutionPlan(t);
    // implement at level 0, review at level 1, fix at level 2 (depends on review).
    expect(plan.groups.map(g => g.steps.map(s => s.id))).toEqual([
      ['implement'],
      ['review'],
      ['fix'],
    ]);
    // The when-clause on 'fix' references 'review' which exists.
    const fixStep = t.steps.find(s => s.id === 'fix')!;
    expect(fixStep.when?.step).toBe('review');
    expect(fixStep.when?.equals).toBe('failed');
  });

  it('parallel-planner has 3 steps at the same level', () => {
    const t = requireTemplate('parallel-planner');
    const plan = resolveExecutionPlan(t);
    expect(plan.groups.length).toBe(1);
    expect(plan.groups[0].steps.map(s => s.id).sort()).toEqual([
      'plan-backend', 'plan-frontend', 'plan-infra',
    ]);
  });

  it('planner-with-review fans in to review, then fix', () => {
    const t = requireTemplate('planner-with-review');
    const plan = resolveExecutionPlan(t);
    expect(plan.groups.map(g => g.steps.map(s => s.id))).toEqual([
      ['plan-frontend', 'plan-backend'],
      ['review'],
      ['fix'],
    ]);
  });

  it('planFor returns ExecutionPlan for a registered template', () => {
    const plan = planFor('simple-loop');
    expect(plan.templateName).toBe('simple-loop');
    expect(plan.groups.length).toBe(1);
  });
});

describe('Template loader — disk priority chain', () => {
  let projectRoot: string;
  let homeDir: string;

  beforeEach(async () => {
    _resetTemplateRegistry();
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'afk-templates-project-'));
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'afk-templates-home-'));
  });
  afterEach(async () => {
    await afs.rm(projectRoot, { recursive: true, force: true });
    await afs.rm(homeDir, { recursive: true, force: true });
  });

  it('loads from project .afk/workflows/<name>.yml when present', async () => {
    const wfDir = path.join(projectRoot, '.afk', 'workflows');
    await afs.mkdir(wfDir, { recursive: true });
    await afs.writeFile(path.join(wfDir, 'custom.yml'), `
name: custom
version: 1
steps:
  - id: only
    role: implementer
    prompt: hi
`);
    const loader = new TemplateLoader({ projectRoot, homeDir });
    const t = await loader.load('custom');
    expect(t.name).toBe('custom');
  });

  it('returns source metadata and resolves prompt files relative to the template', async () => {
    const wfDir = path.join(projectRoot, '.afk', 'workflows');
    await afs.mkdir(wfDir, { recursive: true });
    await afs.writeFile(path.join(wfDir, 'prompt.md'), 'hello');
    await afs.writeFile(path.join(wfDir, 'relative.yml'), `
name: relative
version: 1
steps:
  - id: only
    role: implementer
    prompt: { file: prompt.md }
`);
    const result = await new TemplateLoader({ projectRoot, homeDir }).loadWithSource('relative');
    expect(result.source).toBe('project');
    expect(result.template.steps[0]?.prompt).toEqual({ file: path.join(wfDir, 'prompt.md') });
  });

  it('throws TemplateError when nothing matches and not builtin', async () => {
    const loader = new TemplateLoader({ projectRoot, homeDir });
    await expect(loader.load('nonexistent')).rejects.toThrow(/not found/);
  });

  it('reads inline YAML via direct path', async () => {
    const tmpPath = path.join(projectRoot, 'inline.yml');
    await afs.writeFile(tmpPath, `
name: inline
version: 1
steps:
  - id: only
    role: implementer
    prompt: hi
`);
    const loader = new TemplateLoader({ projectRoot, homeDir });
    const t = await loader.load(tmpPath);
    expect(t.name).toBe('inline');
  });

  it('registerTemplate allows overriding builtin', () => {
    const custom: WorkflowTemplate = {
      name: 'simple-loop',
      version: 1,
      steps: [{ id: 'replaced', role: 'r', prompt: 'p' }],
    };
    registerTemplate(custom);
    const t = getTemplate('simple-loop');
    expect(t?.steps[0].id).toBe('replaced');
  });

  it('builtinTemplates includes QA verification', () => {
    expect(builtinTemplates().length).toBe(6);
    expect(builtinTemplates().some(template => template.name === 'pre-merge-qa-verification')).toBe(true);
  });
});
