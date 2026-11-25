import { describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonlEventStore } from '../../infrastructure/observability/jsonl-event-store.js';
import { buildEvidencePack, type EvidencePack } from './evidence.js';
import { buildAnalysisPrompt, parseAnalysisOutput, parseModelJson, retroModelOutputSchema } from './analysis.js';

function requestFor(pack: EvidencePack) {
  return { version: 1 as const, scope: 'github:acme/api', sourceId: 'session-1', sourceRunId: 'source-run-1', workItemId: 'github:acme/api#1', evidenceDigest: pack.digest, analyzerVersion: '1', reason: 'import' as const };
}

describe('shared analysis without model execution', () => {
  it('requires complete observations for lesson citations and separates target identity from publication authority', async () => {
    const pack = await buildEvidencePack({ sources: [] });
    const prompt = buildAnalysisPrompt(pack, requestFor(pack));
    expect(prompt).toContain('For a lesson, every candidate.evidenceIds entry must have authority="observed" and completeness="complete"');
    expect(prompt).toContain('A target in evidence does not confer publication authority');
  });

  it('puts only validated inline evidence in an untrusted data block and requires the completion envelope', async () => {
    const pack = await buildEvidencePack({ sources: [] });
    const prompt = buildAnalysisPrompt(pack, requestFor(pack));
    expect(prompt).toContain('goal_complete');
    expect(prompt).toContain('distillation');
    expect(prompt).toContain(pack.digest);
    expect(prompt).toContain('"scope":"github:acme/api"');
    expect(prompt).toContain('"sourceRunId":"source-run-1"');
    expect(prompt).toContain('"workItemId":"github:acme/api#1"');
    expect(prompt).toContain('untrusted');
    expect(prompt).toMatch(/incomplete|partial/i);
    expect(prompt).toContain('For this pack, every process candidate requires a step with missingEvidence');
    expect(prompt).not.toContain('--add-dir');
    expect(() => buildAnalysisPrompt({ ...pack, digest: '0'.repeat(64) }, requestFor(pack))).toThrow();
    expect(() => buildAnalysisPrompt(pack, { ...requestFor(pack), evidenceDigest: '0'.repeat(64) })).toThrow(/digest/i);
    expect(() => buildAnalysisPrompt(pack, { ...requestFor(pack), scope: 'not-a-scope' })).toThrow();
    expect(() => buildAnalysisPrompt(pack, { ...requestFor(pack), sourceId: '/private/session.jsonl' })).toThrow(/private paths/i);
  });

  it('validates the envelope and request digest before validating candidate references', async () => {
    const pack = await buildEvidencePack({ sources: [] });
    const request = { version: 1 as const, scope: 'github:acme/api', sourceId: 'session-1', evidenceDigest: pack.digest, analyzerVersion: '1', reason: 'import' as const };
    const output = { version: 1, candidates: [], warnings: ['insufficient evidence'] };
    expect(parseAnalysisOutput(JSON.stringify({ type: 'goal_complete', distillation: output }), request, pack)).toEqual(output);
    expect(() => parseAnalysisOutput({ type: 'goal_complete', distillation: output, authorized: true }, request, pack)).toThrow();
    expect(() => parseAnalysisOutput({ type: 'goal_complete', distillation: output }, { ...request, evidenceDigest: '0'.repeat(64) }, pack)).toThrow(/digest/i);
    expect(() => parseAnalysisOutput({ type: 'goal_complete', distillation: { ...output, candidates: [{ kind: 'fact', title: 'rule', statement: 'rule', evidenceIds: ['invented'], applicability: { project: request.scope, environments: [], versions: [], preconditions: [], exclusions: [], invalidationConditions: [] }, payload: { subject: 'subject', rule: 'rule', classification: 'fact' } }] } }, request, pack)).toThrow(/evidence/i);
  });

  it('describes candidate payloads and marks incomplete processes as gaps', async () => {
    const pack = await buildEvidencePack({ sources: [] });
    const prompt = buildAnalysisPrompt(pack, requestFor(pack));
    for (const field of ['applicability', 'evidenceIds', 'rootCauseStatus', 'evaluationCases', 'sideEffects']) expect(prompt).toContain(field);
    expect(prompt).toContain('preserve both verbatim in the fact payload');
    expect(prompt).toContain('For skill and tool proposals, every candidate.evidenceIds entry must have authority="observed" and completeness="complete"');
    expect(prompt).toContain('authority="observed" and completeness="complete" in both candidate.evidenceIds and each step.evidenceIds');
    expect(prompt).toContain('a required true key goes in applicability.preconditions, a required false key in applicability.exclusions');
    expect(prompt).toContain('report the gap in warnings and omit that process candidate');
    expect(prompt).toContain('at least two distinct normal inputs');
    expect(prompt).toContain('Encode each normal input and expected output as JSON text');
    expect(prompt).toContain('Include a refusal with a schema-invalid input');
    expect(prompt).toContain('A pure computation over supplied arguments has permissions=[]');
  });

  it.each(['skill', 'tool'] as const)('describes only the %s contract in a focused prompt', async kind => {
    const pack = await buildEvidencePack({ sources: [] });
    const prompt = buildAnalysisPrompt(pack, { ...requestFor(pack), candidateKind: kind });
    expect(prompt).toContain(`Evaluate only the ${kind} kind.`);
    expect(prompt).toContain(`kind="${kind}": payload=`);
    for (const other of ['fact', 'process', 'lesson', kind === 'skill' ? 'tool' : 'skill']) {
      expect(prompt).not.toContain(`kind="${other}": payload=`);
    }
    expect(prompt).toContain('authority="observed" and completeness="complete"');
    if (kind === 'skill') {
      expect(prompt).toContain('exact standalone request using observed fixture arguments');
      expect(prompt).toContain('exact serialized answer');
    }
  });

  it('requires complete observed citations in model-generated skill and tool proposals', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'afk-analysis-'));
    try {
      const path = join(root, 'session.jsonl');
      await fs.writeFile(path, '{"role":"user","content":"a declaration"}\n');
      const store = new JsonlEventStore({ root });
      const runId = 'source-run-1';
      await store.append([{ id: 'event', schemaVersion: 1, type: 'qa.started', occurredAt: '2026-11-09T00:00:00Z',
        context: { runId, traceId: 'trace', profileId: 'qa', attempt: 1, workItemId: 'github:acme/api#1', actor: { kind: 'system', id: 'test' } },
        correlationId: runId, data: { kind: 'qa.started' } }]);
      const pack = await buildEvidencePack({ sources: [
        { id: 'audit', kind: 'audit', runId, path: store.pathFor(runId), allowedRoot: root },
        { id: 'session', kind: 'session', path, allowedRoot: root },
      ] });
      const [observed, declared] = pack.entries.map(entry => entry.ref.id);
      const request = requestFor(pack);
      const applicability = { project: request.scope, environments: [], versions: [], preconditions: [], exclusions: [], invalidationConditions: [] };
      const evaluationCases = ['normal', 'recovery', 'refusal'].map(kind => ({ kind, input: kind, expected: kind }));
      const common = { title: 'revision', statement: 'observed operation', applicability };
      const proposals = [
        { ...common, kind: 'skill', payload: { newReason: 'new flow', triggers: ['on request'], prohibitedConditions: [], inputs: [], branches: [], recovery: [], completion: 'done', patch: 'new steps', evaluationCases } },
        { ...common, kind: 'tool', payload: { existingTools: [], inputSchema: {}, outputSchema: {}, dependencies: [], permissions: [], timeoutMs: 1000, sideEffects: 'none', idempotency: 'pure', recovery: 'retry', source: 'return 1', tests: evaluationCases } },
        { ...common, kind: 'fact', payload: { subject: 'subject', rule: 'rule', classification: 'proposal' } },
      ];
      for (const proposal of proposals) {
        const output = (evidenceIds: string[]) => ({ type: 'goal_complete', distillation: {
          version: 1, warnings: [], candidates: [{ ...proposal, evidenceIds }],
        } });
        expect(parseAnalysisOutput(output([observed]), request, pack).candidates).toHaveLength(1);
        if (proposal.kind === 'fact') expect(parseAnalysisOutput(output([declared]), request, pack).candidates).toHaveLength(1);
        else expect(() => parseAnalysisOutput(output([observed, declared]), request, pack)).toThrow(/complete observed evidence/);
      }
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it('rejects complete process claims from partial evidence and model-supplied authority', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'afk-analysis-'));
    try {
      const path = join(root, 'session.jsonl');
      await fs.writeFile(path, '{"role":"user","content":"a declaration"}\n{');
      const pack = await buildEvidencePack({ sources: [{ id: 's1', kind: 'session', path, allowedRoot: root }] });
      const request = { version: 1 as const, scope: 'github:acme/api', sourceId: 's1', evidenceDigest: pack.digest, analyzerVersion: '1', reason: 'import' as const };
      const candidate = { kind: 'process', title: 'partial process', statement: 'a possible path', evidenceIds: [pack.entries[0].ref.id],
        applicability: { project: request.scope, environments: [], versions: [], preconditions: [], exclusions: [], invalidationConditions: [] },
        payload: { entry: 'entry', systems: ['system'], preconditions: [], steps: [{ id: 'step1', action: 'action', stateChange: 'change', evidenceIds: [pack.entries[0].ref.id] }], exceptions: [], completion: 'completion' } };
      const output = { type: 'goal_complete', distillation: { version: 1, candidates: [candidate], warnings: [] } };
      expect(() => parseAnalysisOutput(output, request, pack)).toThrow(/partial|gaps/i);
      const partial = { ...candidate, payload: { ...candidate.payload, steps: [{ ...candidate.payload.steps[0], missingEvidence: 'completion is unknown' }] } };
      expect(parseAnalysisOutput({ ...output, distillation: { ...output.distillation, candidates: [partial] } }, request, pack).candidates).toHaveLength(1);
      expect(() => parseAnalysisOutput({ ...output, distillation: { ...output.distillation, candidates: [{ ...partial, authority: 'published' }] } }, request, pack)).toThrow();
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it('preserves retro model JSON wrappers and category aliases', () => {
    const output = { summary: 'ok', findings: [{ id: 'f1', category: 'process', severity: 'low', title: 't', evidence: ['evidence://1'], rootCause: 'r', recommendation: 'r', confidence: 1, disposition: 'record_only' }] };
    const raw = JSON.stringify([{ type: 'assistant' }, { type: 'result', result: `\`\`\`json\n${JSON.stringify(output)}\n\`\`\`` }]);
    expect(retroModelOutputSchema.parse(parseModelJson(raw)).findings[0].category).toBe('automated_checks');
  });
});
