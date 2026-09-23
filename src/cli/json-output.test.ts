import { afterEach, describe, expect, it, vi } from 'vitest';
import { emitFailure, type JsonFailure } from './json-output';

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

describe('emitFailure', () => {
  it('serializes nested JSON details without changing the failure envelope', () => {
    const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const details: NonNullable<JsonFailure['error']['details']> = {
      hint: 'retry',
      attempts: 2,
      retryable: false,
      metadata: { reasons: ['missing', null] },
    };

    emitFailure('backlog.list', 'validation', 'invalid request', details);

    expect(JSON.parse(String(output.mock.calls[0][0]))).toEqual({
      ok: false,
      kind: 'backlog.list',
      error: { code: 'validation', message: 'invalid request', details },
    });
    expect(process.exitCode).toBe(1);
  });
});
