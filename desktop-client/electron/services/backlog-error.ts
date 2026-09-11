import type { BacklogError, BacklogErrorCode } from "../../shared/backlog-contract";

/**
 * Error type for backlog service failures. Carries the structured
 * `BacklogErrorCode` so the renderer can render recovery UI without
 * re-parsing message strings.
 */
export class BacklogServiceError extends Error {
  public readonly code: BacklogErrorCode;
  public readonly details?: Record<string, unknown>;

  constructor(code: BacklogErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "BacklogServiceError";
    this.code = code;
    if (details) this.details = details;
  }

  toJSON(): BacklogError {
    return this.details
      ? { code: this.code, message: this.message, details: this.details }
      : { code: this.code, message: this.message };
  }
}
