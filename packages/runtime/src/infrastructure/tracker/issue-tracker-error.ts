export type IssueTrackerErrorCode =
  | 'configuration'
  | 'authentication'
  | 'forbidden'
  | 'not-found'
  | 'rate-limited'
  | 'timeout'
  | 'request-failed'
  | 'invalid-response'
  | 'unsupported';

export interface IssueTrackerErrorDetails {
  readonly provider: string;
  readonly operation: string;
  readonly status?: number;
  readonly retryAfterMs?: number;
}

export class IssueTrackerError extends Error {
  readonly code: IssueTrackerErrorCode;
  readonly details: IssueTrackerErrorDetails;

  constructor(code: IssueTrackerErrorCode, message: string, details: IssueTrackerErrorDetails) {
    super(message);
    this.name = 'IssueTrackerError';
    this.code = code;
    this.details = details;
  }
}

export function configurationError(provider: string, operation: string, message: string): IssueTrackerError {
  return new IssueTrackerError('configuration', message, { provider, operation });
}
