import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { assertObservedRecall, protocol, recallCases } from './recall-v1.js';

it('pins the v1 setup, consumer inputs, and answer key independently of product output', () => {
  expect(createHash('sha256').update(JSON.stringify([protocol, recallCases])).digest('hex'))
    .toBe('99baebbfa2fcf01b285c7bc2ac1ea0e032d4b930a68ac1f2ac4200afcfe0589e');
  expect(new Set(recallCases.map(entry => entry.id)).size).toBe(30);
  for (const kind of ['fact', 'process', 'lesson', 'skill', 'tool']) {
    const cases = recallCases.filter(entry => entry.kind === kind);
    expect(cases).toHaveLength(6);
    expect(cases.filter(entry => entry.expected === 'hit')).toHaveLength(2);
  }
});

it('scores fixture observations by case, scope, key and edition', () => {
  const [hit, , excluded] = recallCases;
  const asset = { scope: 'github:w11/parcel', key: 'seal-cutoff', edition: 2 };
  const result = { caseId: hit.id, status: 'observed' as const, ranked: [asset] };
  assertObservedRecall(hit, result);
  for (const ranked of [[], [{ ...asset, scope: excluded.query.scope }], [{ ...asset, key: 'return-handoff' }],
    [{ ...asset, edition: 1 }], [asset, { ...asset, edition: 1 }]]) {
    expect(() => assertObservedRecall(hit, { ...result, ranked })).toThrow();
  }
  expect(() => assertObservedRecall(excluded, { ...result, ranked: [] })).toThrow(/another case/);
  expect(() => assertObservedRecall(excluded, { ...result, caseId: excluded.id })).toThrow();
  assertObservedRecall(excluded, { ...result, caseId: excluded.id, ranked: [] });
  expect(() => assertObservedRecall(excluded, { caseId: excluded.id, status: 'blocked', reason: 'consumer unavailable' }))
    .toThrow(/blocked/);
});
