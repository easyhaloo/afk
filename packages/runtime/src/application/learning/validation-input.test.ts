import { describe, expect, it } from 'vitest';
import { parseLearningValidationInput } from './validation-input.js';
import { validateLearningCandidate } from './validation.js';
import { validateProposalCandidate } from './proposal-validation.js';
import { validateConfiguredLearningCandidate } from './validation-runtime.js';

const request = { scope: 'github:acme/api', candidateId: 'a'.repeat(64), expectedVersion: 1, checkerId: 'checker' };

describe('shared validation request boundary', () => {
  it('accepts only the four owned data fields, including null-prototype JSON objects', () => {
    expect(parseLearningValidationInput(request)).toEqual({ success: true, data: request });
    expect(parseLearningValidationInput(Object.assign(Object.create(null), request))).toEqual({ success: true, data: request });
    expect(parseLearningValidationInput(Object.create(request))).toBeUndefined();
  });

  it.each(Object.keys(request))('rejects an accessor without reading it (%s)', field => {
    let reads = 0;
    const input = Object.defineProperty({ ...request }, field, { enumerable: true, get: () => { reads++; throw new Error('getter invoked'); } });
    expect(parseLearningValidationInput(input)).toBeUndefined();
    expect(reads).toBe(0);
  });

  it.each([null, [], 'request', {}, { ...request, passed: true }, { ...request, [Symbol('hidden')]: true },
    { ...request, expectedVersion: 0 }, { ...request, expectedVersion: Infinity }, { ...request, candidateId: '../unsafe' },
    Object.defineProperty({ ...request }, 'checkerId', { value: 'checker', enumerable: false }),
  ])('rejects malformed or additional input (%#)', input => {
    expect(parseLearningValidationInput(input)?.success).not.toBe(true);
  });

  it('applies the same accessor boundary before all three public validation implementations', async () => {
    let reads = 0;
    const input = Object.defineProperty({ ...request }, 'scope', { enumerable: true, get: () => { reads++; throw new Error('getter invoked'); } });
    const blocked = { status: 'blocked', code: 'invalid_input' };
    expect(await validateLearningCandidate(input, {} as never)).toEqual(blocked);
    expect(await validateProposalCandidate(input, {} as never)).toEqual(blocked);
    expect(await validateConfiguredLearningCandidate(input, { file: '/unused/ledger.sqlite', configurationFile: '/unused/checkers.json',
      resolveProvider: async () => { throw new Error('resolver invoked'); } })).toEqual(blocked);
    expect(reads).toBe(0);
  });
});
