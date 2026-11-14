import type { ProviderOperationOptions } from '../../plugin-sdk/capabilities.js';

export async function withCancellation<Result>(operation: () => Result | Promise<Result>, options?: ProviderOperationOptions): Promise<Result> {
  const signal = options?.signal;
  if (!signal) return operation();
  const check = () => { if (signal.aborted) throw signal.reason ?? new Error('Provider operation aborted'); };
  check();
  const value = await operation();
  check();
  return value;
}
