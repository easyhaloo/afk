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
  it('asks for a single revision when complete observations identify a repaired asset', async () => {
    const pack = await buildEvidencePack({ sources: [] });
    const preference = 'When complete observations identify an existing repository asset and show its behavior before and after repair, return only one grounded revision of that asset.';
    const repair = buildAnalysisPrompt(pack, { ...requestFor(pack), reason: 'repaired' });
    expect(repair).toContain(preference);
    expect(repair).toContain('Cite only the complete observations for validation');
    expect(buildAnalysisPrompt(pack, requestFor(pack))).not.toContain(preference);
  });

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
    expect(prompt).not.toMatch(/"distillation":\{"version":1,"candidates":\[\]/);
    expect(prompt).toContain('Emit candidates for supported findings even when other findings are uncertain');
    expect(prompt).toContain('The payload field completion belongs only to process and skill');
    expect(prompt).toContain('"version":1, "candidates" (array of Candidate), and "warnings" (array of strings)');
    expect(prompt).toContain('Return an empty candidates array only if no candidate is supported');
    expect(prompt).toMatch(/preserve both verbatim in the fact payload/i);
    expect(prompt).toContain('For skill and tool proposals, every candidate.evidenceIds entry must have authority="observed" and completeness="complete"');
    expect(prompt).toContain('authority="observed" and completeness="complete" in both candidate.evidenceIds and each step.evidenceIds');
    expect(prompt).toContain('For all candidate kinds, applicability.preconditions, applicability.exclusions and applicability.invalidationConditions contain only machine-readable boolean keys from observed evidence');
    expect(prompt).toContain('a required true key goes in applicability.preconditions, a required false key in applicability.exclusions');
    expect(prompt).toContain('Do not invent keys from prose or repeat project, environment or version restrictions in the boolean arrays');
    expect(prompt).toContain('report the gap in warnings and omit that process candidate');
    expect(prompt).toContain('at least two distinct normal inputs');
    expect(prompt).toContain('Encode each normal input and expected output as JSON text');
    expect(prompt).toContain('Include a refusal with a schema-invalid input');
    expect(prompt).toContain('A pure computation over supplied arguments has permissions=[]');
    expect(prompt).toContain('copy the exact logical reference into top-level targetRef');
    expect(prompt).toContain('A correction journal can explain the revision, but cannot supply observed evidence');
    expect(prompt).toContain('Preserve the existing entry point, interpreter, module format and argument encoding');
    expect(prompt).toContain('decode argv[2] once and dispatch on the decoded value');
    expect(prompt).toContain('preserve field names, value semantics and serialization');
    expect(prompt).toContain('Match any observed checkpoint examples byte for byte');
    expect(prompt).toContain('Only classify successful calls with JSON output as normal tests');
    expect(prompt).toContain('omit cancellation, timeout, permission denial and multi-step recovery from payload.tests');
    expect(prompt).toContain('A schema-valid input that hits a runtime permission denial is not a refusal test');
    expect(prompt).toContain('multi-step recovery behavior in the source and recovery description for the independent checker');
    expect(prompt).toContain('Do not copy redaction markers from evidence into executable source');
    expect(prompt).toContain('Checker-provided scratch writes use sideEffects="filesystem"');
    expect(prompt).toContain('include those actual JSON arguments in inputSchema, including both phases of recovery');
    expect(prompt).toContain('use anyOf with a separate schema for each shape');
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
        { ...common, kind: 'tool', payload: { existingTools: [], inputSchema: { type: 'integer' }, outputSchema: { type: 'integer' }, dependencies: [], permissions: [], timeoutMs: 1000, sideEffects: 'none', idempotency: 'pure', recovery: 'retry', source: 'return 1', tests: [
          { kind: 'normal', input: '1', expected: '1' },
          { kind: 'normal', input: '2', expected: '1' },
          { kind: 'refusal', input: 'null', expected: 'refused' },
        ] } },
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
