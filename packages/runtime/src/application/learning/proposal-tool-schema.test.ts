import { describe, expect, it } from 'vitest';
import { checkProposalToolParameterPaths, compileProposalToolSchema } from './proposal-tool-schema.js';
import type { ProposalToolSchema } from './proposal-tool-schema.js';

describe('shared proposal tool schemas', () => {
  it('validates inputs without coercing or removing parameters', () => {
    const validate = compileProposalToolSchema({ type: 'object', properties: { count: { type: 'integer' } }, required: ['count'], additionalProperties: false });
    expect(validate({ count: 2 })).toBe(true);
    const input = { count: '2', extra: true };
    expect(validate(input)).toBe(false);
    expect(input).toEqual({ count: '2', extra: true });
    expect(() => checkProposalToolParameterPaths({ nested: [{ '/private': 'value' }] })).toThrow('absolute paths');
    expect(() => checkProposalToolParameterPaths({ nested: ['relative/file'] })).not.toThrow();
  });

  it.each([
    { $ref: 'file:///private/schema' }, { $dynamicRef: '#input' }, { type: 'object', patternProperties: { '.*': {} } },
    { type: 'string', pattern: '(a+)+' }, { type: 'string', description: 'x'.repeat(8192) },
    Array.from({ length: 18 }).reduce<ProposalToolSchema>(schema => ({ type: 'object', properties: { nested: schema } }), {}),
  ])('preserves bounded schema restrictions %#', schema => {
    expect(() => compileProposalToolSchema(schema)).toThrow();
  });
});
