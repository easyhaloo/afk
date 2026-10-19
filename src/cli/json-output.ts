/**
 * Structured JSON output protocol for CLI commands consumed by external
 * callers (for example, the AFK Control desktop client).
 *
 * stdout envelope shapes:
 *   success: { ok: true,  kind: string, data: T }
 *   failure: { ok: false, kind: string, error: { code, message, details? } }
 *
 * When a command is invoked with `--json`, the action handler MUST emit
 * exactly one envelope on stdout, never human-formatted text. All human
 * output (chalk colors, hints, context) goes to stderr in non-JSON mode
 * only. Failure sets exit code 1 after writing the envelope so callers can
 * detect protocol-level failures without truncating stdout.
 */

import { classifyError, type ErrorCode } from '@afk/application';

export { classifyError };
export type { ErrorCode };

export type JsonSuccess<T> = {
  ok: true;
  kind: string;
  data: T;
};

export type JsonValue = string | number | boolean | null | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export interface JsonFailureDetails {
  readonly hint?: string;
  readonly [key: string]: JsonValue | undefined;
}

export type JsonFailure = {
  ok: false;
  kind: string;
  error: {
    code: ErrorCode;
    message: string;
    details?: JsonFailureDetails;
  };
};

export type JsonEnvelope<T> = JsonSuccess<T> | JsonFailure;

export function emitSuccess<T>(kind: string, data: T): void {
  const envelope: JsonSuccess<T> = { ok: true, kind, data };
  process.stdout.write(JSON.stringify(envelope));
}

export function emitFailure(
  kind: string,
  code: ErrorCode,
  message: string,
  details?: JsonFailureDetails,
): void {
  const envelope: JsonFailure = {
    ok: false,
    kind,
    error: details ? { code, message, details } : { code, message },
  };
  process.stdout.write(JSON.stringify(envelope));
  process.exitCode = 1;
}

