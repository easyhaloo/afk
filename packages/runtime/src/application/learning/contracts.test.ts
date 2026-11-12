import { describe, expect, it } from 'vitest';
import {
  assertCandidateTransition, distillationKey, distillationOutputSchema,
  distillationRequestSchema, evidenceRefSchema, parseDistillationOutput,
} from './contracts.js';

const request = {
  version: 1, scope: 'github:acme/api', sourceId: 'run:r1', sourceRunId: 'r1',
  workItemId: 'github:acme/api#42', evidenceDigest: 'a'.repeat(64),
  analyzerVersion: '1', reason: 'completed',
} as const;
const evidence = {
  id: 'e1', kind: 'code', digest: 'b'.repeat(64), locator: 'revision:abc:rules',
  completeness: 'complete', authority: 'observed',
} as const;
const fact = {
  kind: 'fact', title: 'Approval rule', statement: 'An approval is required.', evidenceIds: ['e1'],
  applicability: { project: request.scope, environments: [], versions: ['abc'],
    preconditions: ['submitted'], exclusions: [], invalidationConditions: ['rule changes'] },
  payload: { subject: 'approval', rule: 'Approval is required before publishing', classification: 'fact' },
};
const output = { version: 1, candidates: [fact], warnings: [] };

describe('distillation contracts', () => {
  it('keeps canonical source identities separate and rejects scope drift', () => {
    expect(distillationRequestSchema.parse(request)).toEqual(request);
    for (const change of [
      { scope: 'acme/api' }, { scope: 'github:acme/api/extra' },
      { workItemId: '42' }, { workItemId: 'github:other/api#42' },
      { workItemId: 'github:acme/api#0' }, { sourceRunId: 'bad\nidentity' },
      { evidenceDigest: 'unknown' }, { reason: 'failed' }, { state: 'verified' },
    ]) expect(distillationRequestSchema.safeParse({ ...request, ...change }).success).toBe(false);
  });

  it('uses a stable key covering project, source, content and analyzer version', () => {
    expect(distillationKey(request)).toMatch(/^[a-f0-9]{64}$/);
    expect(distillationKey({ ...request })).toBe(distillationKey(request));
    for (const change of [
      { scope: 'github:acme/other', workItemId: 'github:acme/other#42' },
      { sourceId: 'run:r2' }, { evidenceDigest: 'c'.repeat(64) }, { analyzerVersion: '2' },
    ]) expect(distillationKey({ ...request, ...change })).not.toBe(distillationKey(request));
  });

  it('accepts only bounded evidence references with explicit completeness and authority', () => {
    expect(evidenceRefSchema.parse(evidence)).toEqual(evidence);
    expect(evidenceRefSchema.safeParse({ ...evidence, locator: 'one\ntwo' }).success).toBe(false);
    expect(evidenceRefSchema.safeParse({ ...evidence, authority: 'verified' }).success).toBe(false);
    expect(evidenceRefSchema.safeParse({ ...evidence, credential: 'secret' }).success).toBe(false);
  });

  it('binds model proposals to the supplied evidence and exact project', () => {
    expect(parseDistillationOutput(JSON.stringify(output), request, [evidence])).toEqual(output);
    expect(() => parseDistillationOutput({ ...output, candidates: [{ ...fact, evidenceIds: ['missing'] }] }, request, [evidence]))
      .toThrow(/evidence/i);
    expect(() => parseDistillationOutput({ ...output, candidates: [{ ...fact,
      applicability: { ...fact.applicability, project: 'github:other/api' } }] }, request, [evidence])).toThrow(/scope|project/i);
    expect(() => parseDistillationOutput(output, request, [{ ...evidence, id: 'e2' }])).toThrow(/evidence/i);
  });

  it('rejects model authority, absolute publication targets and mismatched payloads', () => {
    for (const change of [
      { state: 'validated' }, { id: 'model-owned' }, { targetRef: '/etc/config' },
      { targetRef: '../secrets' }, { targetRef: 'C:\\private\\file' },
      { kind: 'tool' }, { payload: { ...fact.payload, verified: true } },
    ]) expect(distillationOutputSchema.safeParse({ ...output, candidates: [{ ...fact, ...change }] }).success).toBe(false);
  });

  it('enforces UTF-8, candidate and whole-output bounds before accepting proposals', () => {
    expect(distillationOutputSchema.safeParse({ ...output, candidates: Array(11).fill(fact) }).success).toBe(false);
    expect(() => parseDistillationOutput(' '.repeat(32769), request, [evidence])).toThrow(/limit|large|size/i);
    expect(() => parseDistillationOutput({ ...output, warnings: ['中'.repeat(12000)] }, request, [evidence])).toThrow();
    expect(() => parseDistillationOutput('```json\n{}\n```', request, [evidence])).toThrow();
  });

  it('requires evidence on process nodes and kind-specific skill/tool contracts', () => {
    const payloads = [
      { kind: 'process', payload: { entry: 'submit', systems: ['api'], preconditions: [],
        steps: [{ id: 's1', action: 'approve', stateChange: 'submitted → approved', evidenceIds: [] }],
        exceptions: [], completion: 'approved' } },
      { kind: 'lesson', payload: { trigger: 'failure', rootCause: 'guess', rootCauseStatus: 'certain',
        attempts: [], fix: 'retry', prevention: [] } },
      { kind: 'skill', payload: { patch: 'do everything' } },
      { kind: 'tool', payload: { source: 'run()' } },
    ];
    for (const proposal of payloads) expect(distillationOutputSchema.safeParse({ ...output,
      candidates: [{ ...fact, ...proposal }] }).success).toBe(false);
  });

  it('accepts all five asset kinds and validates nested process evidence', () => {
    const evaluations = ['normal', 'recovery', 'refusal'].map(kind => ({ kind, input: 'example', expected: 'verified outcome' }));
    const proposals = [fact,
      { ...fact, kind: 'process', payload: { entry: 'submit', systems: ['api'], preconditions: [],
        steps: [{ id: 's1', action: 'approve', stateChange: 'submitted → approved', evidenceIds: ['e1'] }],
        exceptions: ['reject'], completion: 'approved' } },
      { ...fact, kind: 'lesson', payload: { trigger: 'failed', rootCause: 'missing transaction', rootCauseStatus: 'confirmed',
        attempts: ['retry'], fix: 'BEGIN IMMEDIATE', prevention: ['independent concurrent regression'] } },
      { ...fact, kind: 'skill', payload: { targetSkill: 'skill:existing', originalDigest: 'c'.repeat(64),
        triggers: ['requested review'], prohibitedConditions: ['unrelated task'], inputs: [], branches: [],
        recovery: ['restore'], completion: 'checks pass', patch: 'review evidence first', evaluationCases: evaluations } },
      { ...fact, kind: 'tool', payload: { existingTools: ['existing-cli'], inputSchema: { type: 'object' },
        outputSchema: { type: 'object' }, dependencies: [], permissions: [], timeoutMs: 1000,
        sideEffects: 'none', idempotency: 'read only', recovery: 'none required', source: 'return input', tests: evaluations } },
    ];
    expect(parseDistillationOutput({ ...output, candidates: proposals }, request, [evidence]).candidates.map(candidate => candidate.kind))
      .toEqual(['fact', 'process', 'lesson', 'skill', 'tool']);
    const process = proposals[1]!;
    expect(() => parseDistillationOutput({ ...output, candidates: [{ ...process, payload: {
      ...(process.payload as object), steps: [{ id: 's1', action: 'approve', stateChange: 'approved', evidenceIds: ['unknown'] }],
    } }] }, request, [evidence])).toThrow(/evidence/i);
    expect(() => parseDistillationOutput(output, request, [evidence, evidence])).toThrow(/duplicate/i);
    expect(distillationRequestSchema.parse({ ...request, scope: 'gitlab:git.example.com/team/api',
      workItemId: 'gitlab:git.example.com/team/api#42' }).scope).toBe('gitlab:git.example.com/team/api');
  });

  it('does not allow publication before validation or resurrection of terminal assets', () => {
    expect(() => assertCandidateTransition('candidate', 'validated')).not.toThrow();
    expect(() => assertCandidateTransition('validated', 'published')).not.toThrow();
    expect(() => assertCandidateTransition('published', 'revoked')).not.toThrow();
    expect(() => assertCandidateTransition('candidate', 'published')).toThrow();
    for (const state of ['rejected', 'revoked', 'superseded'] as const) {
      expect(() => assertCandidateTransition(state, 'validated')).toThrow();
    }
  });
});
