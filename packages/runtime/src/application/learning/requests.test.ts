import { describe, expect, it } from 'vitest';
import { prepareDistillationRequest, canonicalLearningJson } from './requests.js';

import { request, evidence } from './ledger-data.fixture.spec.js';

describe('learning request preparation', () => {
  it('canonicalizes object order and evidence ordering without changing array semantics', () => {
    expect(canonicalLearningJson({ z: 1, a: { y: 2, x: 3 } })).toBe('{"a":{"x":3,"y":2},"z":1}');
    const first = prepareDistillationRequest({ request, evidence: [evidence] });
    expect(prepareDistillationRequest({ evidence: [{ ...evidence }], request: { ...request } })).toEqual(first);
    expect(first.key).toMatch(/^[a-f0-9]{64}$/);
    const second = { ...evidence, id: 'e2' };
    expect(prepareDistillationRequest({ request, evidence: [evidence, second] }))
      .toEqual(prepareDistillationRequest({ request, evidence: [second, evidence] }));
  });

  it('accepts packs with more than 64 references while retaining count and total UTF-8 byte limits', () => {
    const refs = Array.from({ length: 100 }, (_, index) => ({ ...evidence, id: `e${index}` }));
    expect(prepareDistillationRequest({ request, evidence: refs }).evidence).toHaveLength(100);
    expect(() => prepareDistillationRequest({ request, evidence: Array.from({ length: 4097 }, (_, index) => ({ ...evidence, id: `e${index}` })) })).toThrow();
    expect(() => prepareDistillationRequest({ request, evidence: refs.map(entry => ({ ...entry, locator: '中'.repeat(512) })) })).toThrow(/size|limit/i);
  });

  it('requires explicit blocking for missing evidence and rejects duplicate references and extra authority', () => {
    expect(() => prepareDistillationRequest({ request, evidence: [] })).toThrow(/evidence/i);
    expect(prepareDistillationRequest({ request, evidence: [], blockedReason: 'source unavailable' }).blockedReason)
      .toBe('source unavailable');
    expect(() => prepareDistillationRequest({ request, evidence: [evidence, evidence] })).toThrow(/duplicate/i);
    expect(() => prepareDistillationRequest({ request: { ...request, state: 'published' }, evidence: [evidence] } as never)).toThrow();
    expect(() => prepareDistillationRequest({ request, evidence: [evidence], blockedReason: ' ' })).toThrow();
  });
});
