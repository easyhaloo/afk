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
