import { APIRequestContext } from '@playwright/test';

export interface PollOptions {
  intervalMs?: number;
  timeoutMs?: number;
}

/**
 * Poll an endpoint until the supplied predicate confirms completion.
 * Status names, endpoint paths, and timeout values belong to the target application.
 */
export async function pollUntil<T = unknown>(
  apiContext: APIRequestContext,
  endpoint: string,
  isComplete: (data: T) => boolean,
  options: PollOptions = {},
): Promise<T> {
  const { intervalMs = 2_000, timeoutMs = 30_000 } = options;
  const deadline = Date.now() + timeoutMs;
  let lastData: T | undefined;

  while (Date.now() < deadline) {
    const response = await apiContext.get(endpoint);
    if (!response.ok()) {
      throw new Error(`Polling request failed: ${response.status()} ${endpoint}`);
    }

    lastData = (await response.json()) as T;
    if (isComplete(lastData)) {
      return lastData;
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error(`Polling timed out after ${timeoutMs}ms: ${endpoint}`);
}
