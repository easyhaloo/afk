import { describe, it, expect } from 'vitest';
import { parseTemplate } from './loader.js';
import { resolveExecutionPlan } from './compiler.js';
import { TemplateCatalog } from './catalog.js';
import { builtinTemplates } from './builtin.js';
import type { WorkflowTemplate } from './types.js';

describe('Template schema — validation', () => {
  it('rejects templates with no steps', () => {
    expect(() => parseTemplate(`
name: empty
version: 1
steps: []
`, 'empty')).toThrow(/at least 1/);
  });

  it('rejects invalid branch strategy type', () => {
    expect(() => parseTemplate(`
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
    expect(() => parseTemplate(`
name: bad-id
version: 1
steps:
  - id: BadId
    role: implementer
    prompt: hi
`, 'bad-id')).toThrow(/kebab-case/);
  });

  it('rejects when clause without equals or notEquals', () => {
    expect(() => parseTemplate(`
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
    const t = parseTemplate(`
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

describe('Dependency resolution', () => {
  function mkTemplate(steps: Array<{ id: string; dependsOn?: string[]; parallel?: string; when?: { step: string; equals?: 'completed' | 'failed' | 'aborted' | 'timed_out'; notEquals?: 'completed' | 'failed' | 'aborted' | 'timed_out' } }>): WorkflowTemplate {
    return {
      name: 'test',
      version: 1,
      steps: steps.map(s => ({
        id: s.id,
        role: 'r',
        prompt: 'p',
        dependsOn: s.dependsOn,
        parallel: s.parallel,
        when: s.when,
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

  it('orders a step after the step its when-clause names', () => {
    // A forward reference: 'b' decides on 'c', so 'c' has to run first.
    const t = mkTemplate([
      { id: 'a' },
      { id: 'b', when: { step: 'c', equals: 'completed' } },
      { id: 'c' },
    ]);
    const plan = resolveExecutionPlan(t);
    expect(plan.groups.map(g => g.steps.map(s => s.id))).toEqual([['a', 'c'], ['b']]);
  });

  it('counts a step named by both dependsOn and when once', () => {
    const t = mkTemplate([
      { id: 'a' },
      { id: 'b', dependsOn: ['a'], when: { step: 'a', equals: 'completed' } },
    ]);
    const plan = resolveExecutionPlan(t);
    expect(plan.groups.map(g => g.steps.map(s => s.id))).toEqual([['a'], ['b']]);
  });

  it('accepts a parallel group whose members share a level', () => {
    const t = mkTemplate([
      { id: 'a', parallel: 'group' },
      { id: 'b', parallel: 'group' },
    ]);
    const plan = resolveExecutionPlan(t);
    expect(plan.groups).toHaveLength(1);
    expect(plan.groups[0].steps.map(s => s.id)).toEqual(['a', 'b']);
  });

  it('rejects a parallel group whose members depend on each other', () => {
    const t = mkTemplate([
      { id: 'a', parallel: 'group' },
      { id: 'b', parallel: 'group', dependsOn: ['a'] },
    ]);
    expect(() => resolveExecutionPlan(t)).toThrow(/parallel group 'group' is split across levels/);
  });

  it('detects a when-clause that references itself', () => {
    const t = mkTemplate([{ id: 'a', when: { step: 'a', equals: 'completed' } }]);
    expect(() => resolveExecutionPlan(t)).toThrow(/itself/);
  });

  it('detects a cycle formed across dependsOn and a when-clause', () => {
    const t = mkTemplate([
      { id: 'a', dependsOn: ['b'] },
      { id: 'b', when: { step: 'a', equals: 'completed' } },
    ]);
    expect(() => resolveExecutionPlan(t)).toThrow(/cycle/);
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

describe('Builtin templates', () => {
  const catalog = new TemplateCatalog();

  it('all builtin templates are registered', () => {
    expect(catalog.names().sort()).toEqual([
      'issue-implementation',
      'parallel-planner',
      'planner-with-review',
      'pre-merge-qa-verification',
      'sequential-review',
      'simple-loop',
    ]);
  });

  it('issue-implementation has 4 steps in dependency order', () => {
    const t = catalog.find('issue-implementation')!;
    const plan = resolveExecutionPlan(t);
    expect(plan.groups.map(g => g.steps.map(s => s.id))).toEqual([
      ['implement'],
      ['verify-ac'],
      ['publish'],
      ['queue-qa'],
    ]);
  });

  it('implementation delegates merge-request publication to QA', () => {
    const template = catalog.find('issue-implementation')!;
    const step = template.steps.find(item => item.id === 'implement');
    expect(step?.prompt).toContain('不要创建或合并 MR');
  });

  it('QA verification delegates change publication to the runner', () => {
    const template = catalog.find('pre-merge-qa-verification')!;
    const step = template.steps.find(item => item.id === 'verify-ac');
    expect(step?.prompt).toContain('不要把 commit、push 或创建 MR 作为本次 Agent 的失败条件');
  });

  it('sequential-review fix step is gated on review=failed', () => {
    const t = catalog.find('sequential-review')!;
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
    const t = catalog.find('parallel-planner')!;
    const plan = resolveExecutionPlan(t);
    expect(plan.groups.length).toBe(1);
    expect(plan.groups[0].steps.map(s => s.id).sort()).toEqual([
      'plan-backend', 'plan-frontend', 'plan-infra',
    ]);
  });

  it('planner-with-review fans in to review, then fix', () => {
    const t = catalog.find('planner-with-review')!;
    const plan = resolveExecutionPlan(t);
    expect(plan.groups.map(g => g.steps.map(s => s.id))).toEqual([
      ['plan-frontend', 'plan-backend'],
      ['review'],
      ['fix'],
    ]);
  });

  it('the catalogue compiles a registered template into the one plan', () => {
    const plan = catalog.compile(catalog.find('simple-loop')!);
    expect(plan.templateName).toBe('simple-loop');
    expect(plan.groups.length).toBe(1);
  });

  it('every built-in agent step declares its phase and its completion kind', () => {
    // The built-ins never rely on the legacy derivation: the runner reads the
    // decision off the step.
    for (const template of builtinTemplates()) {
      for (const step of template.steps) {
        if (step.kind === 'system') continue;
        expect(step.phase, `${template.name}/${step.id} declares no phase`).toBeDefined();
        expect(step.completionKind, `${template.name}/${step.id} declares no completion kind`).toBeDefined();
      }
    }
  });

  it('the built-in acceptance-criteria step speaks the AC protocol', () => {
    const template = builtinTemplates().find(item => item.name === 'issue-implementation')!;
    const verification = template.steps.find(step => step.id === 'verify-ac');
    expect(verification).toMatchObject({ phase: 'verification', completionKind: 'ac' });
    const implementation = template.steps.find(step => step.id === 'implement');
    expect(implementation).toMatchObject({ phase: 'implementation', completionKind: 'task' });
  });

  it('the built-in QA template speaks the QA protocol', () => {
    const template = builtinTemplates().find(item => item.name === 'pre-merge-qa-verification')!;
    expect(template.steps[0]).toMatchObject({ phase: 'verification', completionKind: 'qa' });
  });

  it('builtinTemplates includes QA verification', () => {
    expect(builtinTemplates().length).toBe(6);
    expect(builtinTemplates().some(template => template.name === 'pre-merge-qa-verification')).toBe(true);
  });
});
