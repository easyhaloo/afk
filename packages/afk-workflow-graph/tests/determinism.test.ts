import { describe, expect, it } from 'vitest';
import { createReceipt, layoutWorkflow } from '../src';

describe('determinism', () => {
  it('produces equal snapshots and receipts for equal definitions', () => {
    const definition = { templateId: 'x', templateVersion: 1, name: 'X', steps: [{ id: 'a', dependsOn: [] }, { id: 'b', dependsOn: ['a'] }] };
    const first = layoutWorkflow(definition); const second = layoutWorkflow(definition);
    expect(first).toEqual(second);
    expect(createReceipt(definition, first, 'test', '2026-01-01T00:00:00.000Z')).toEqual(createReceipt(definition, second, 'test', '2026-01-01T00:00:00.000Z'));
  });
});
