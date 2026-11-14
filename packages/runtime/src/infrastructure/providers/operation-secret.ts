import { z } from 'zod';
import type { CredentialValue, ProviderOperationOptions } from '../../plugin-sdk/capabilities.js';
import { checkAbort } from './dependencies.js';

export type OperationSecret = string | ((options?: ProviderOperationOptions) => Promise<CredentialValue>);

const credential = z.object({
  secret: z.string().refine(value => Boolean(value.trim()) && !/[\0\r\n]/.test(value)),
  expiresAt: z.string().datetime({ offset: true }).refine(value => Number.isFinite(Date.parse(value))).optional(),
  revoked: z.boolean().optional(),
});

export function validateOperationCredential(result: unknown): CredentialValue {
  const value = credential.parse(result);
  if (value.revoked || (value.expiresAt !== undefined && Date.parse(value.expiresAt) <= Date.now())) throw new Error('Operation credential unavailable');
  return value;
}

export async function resolveOperationCredential(source: OperationSecret, options?: ProviderOperationOptions): Promise<CredentialValue> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    checkAbort(options);
    const interrupted = new Promise<never>((_resolve, reject) => {
      abort = () => reject(new Error('Operation credential unavailable'));
      options?.signal?.addEventListener('abort', abort, { once: true });
      if (options?.signal?.aborted) abort();
      if (options?.deadlineAt !== undefined) {
        const expire = () => {
          const remaining = options.deadlineAt! - Date.now();
          if (remaining <= 0) abort!();
          else timer = setTimeout(expire, Math.min(remaining, 2_147_483_647));
        };
        expire();
      }
    });
    const result = await Promise.race([typeof source === 'string' ? { secret: source } : Promise.resolve().then(() => { checkAbort(options); return source(options); }), interrupted]);
    checkAbort(options);
    return validateOperationCredential(result);
  } catch {
    throw new Error('Operation credential unavailable');
  } finally {
    clearTimeout(timer);
    if (abort) options?.signal?.removeEventListener('abort', abort);
  }
}

export async function resolveOperationSecret(source: OperationSecret, options?: ProviderOperationOptions): Promise<string> {
  return (await resolveOperationCredential(source, options)).secret;
}

export async function resolveWebhook(source: OperationSecret, options?: ProviderOperationOptions): Promise<string> {
  const value = await resolveOperationSecret(source, options);
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || value.includes('#')) throw new Error();
    return value;
  } catch { throw new Error('Invalid webhook configuration'); }
}
