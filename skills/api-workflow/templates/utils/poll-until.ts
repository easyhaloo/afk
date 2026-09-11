// ============================================================
// Poll Until Utility
// ============================================================
// Polls an API endpoint until status matches expected value
// or timeout is reached.
// ============================================================

import { APIRequestContext } from '@playwright/test';

export interface PollOptions {
  intervalMs?: number;
  timeoutMs?: number;
}

export interface PollResult {
  status: string;
  result: any;
}

/**
 * Poll an endpoint until status matches expected values
 *
 * @param apiContext - Playwright APIRequestContext
 * @param endpoint - GET endpoint to poll (e.g., `/jobs/{id}`)
 * @param getKey - Function to extract status from response
 * @param expectedStatus - Array of status values that indicate completion
 * @param options - Poll options (interval, timeout)
 */
export async function pollUntil<T = any>(
  apiContext: APIRequestContext,
  endpoint: string,
  getKey: (data: any) => string,
  expectedStatus: string[],
  options: PollOptions = {}
): Promise<T> {
  const { intervalMs = 2000, timeoutMs = 30000 } = options;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const res = await apiContext.get(endpoint);
    if (!res.ok()) {
      throw new Error(`Poll failed: ${res.status()}`);
    }

    const data = await res.json();
    const status = getKey(data);

    if (expectedStatus.includes(status)) {
      return data as T;
    }

    await new Promise(r => setTimeout(r, intervalMs));
  }

  throw new Error(`Poll timeout for ${endpoint}`);
}

/**
 * Poll order status until PAID
 *
 * @example
 * const order = await pollOrderPaid(apiContext, `/orders/${orderId}`);
 */
export async function pollOrderPaid(
  apiContext: APIRequestContext,
  orderId: string,
  options: PollOptions = {}
): Promise<any> {
  return pollUntil(
    apiContext,
    `/orders/${orderId}`,
    (data) => data.status,
    ['PAID', 'COMPLETED'],
    options
  );
}

/**
 * Poll job status until COMPLETED
 *
 * @example
 * const job = await pollJobComplete(apiContext, `/jobs/${jobId}`);
 */
export async function pollJobComplete(
  apiContext: APIRequestContext,
  jobId: string,
  options: PollOptions = {}
): Promise<any> {
  return pollUntil(
    apiContext,
    `/jobs/${jobId}`,
    (data) => data.status,
    ['COMPLETED', 'SUCCESS'],
    options
  );
}
