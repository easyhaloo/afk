export type ErrorCode = 'auth' | 'not_found' | 'validation' | 'provider' | 'unknown';

export function classifyError(error: unknown): ErrorCode {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  if (['authentication', 'unauthorized', 'auth login', 'github_token', 'gitlab_token', 'not authenticated'].some(text => message.includes(text))) return 'auth';
  if (['not found', 'does not exist', '404'].some(text => message.includes(text))) return 'not_found';
  if (['invalid', 'must ', 'argument'].some(text => message.includes(text)) || /\bexpected\s/.test(message)) return 'validation';
  if (message.includes('api') || message.includes('http')) return 'provider';
  return 'unknown';
}
