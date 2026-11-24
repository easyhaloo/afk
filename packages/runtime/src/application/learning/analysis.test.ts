import { describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildEvidencePack, type EvidencePack } from './evidence.js';
import { buildAnalysisPrompt, parseAnalysisOutput, parseModelJson, retroModelOutputSchema } from './analysis.js';

function requestFor(pack: EvidencePack) {
  return { version: 1 as const, scope: 'github:acme/api', sourceId: 'session-1', sourceRunId: 'source-run-1', workItemId: 'github:acme/api#1', evidenceDigest: pack.digest, analyzerVersion: '1', reason: 'import' as const };
}

describe('shared analysis without model execution', () => {
  it('prioritizes grounded asset revisions during repair distillation', async () => {
    const pack = await buildEvidencePack({ sources: [] });
    const preference = 'prioritize one grounded revision of that asset';
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
    expect(prompt).toContain('Preserve the existing entry point, interpreter and module format');
    expect(prompt).toContain('preserve field names, value semantics and serialization');
    expect(prompt).toContain('Do not add undocumented checkpoint fields');
    expect(prompt).toContain('Only classify successful calls with JSON output as normal tests');
    expect(prompt).toContain('omit cancellation, timeout, permission denial and multi-step recovery from payload.tests');
    expect(prompt).toContain('A schema-valid input that hits a runtime permission denial is not a refusal test');
    expect(prompt).toContain('multi-step recovery behavior in the source and recovery description for the independent checker');
    expect(prompt).toContain('Do not copy redaction markers from evidence into executable source');
    expect(prompt).toContain('Checker-provided scratch writes use sideEffects="filesystem"');
    expect(prompt).toContain('include those actual JSON arguments in inputSchema, including both phases of recovery');
    expect(prompt).toContain('use anyOf with a separate schema for each shape');
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
