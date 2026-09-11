// ============================================================
// Order Flow Scenario
// ============================================================
// Example: Complete order flow from login to order completion
//
// This file demonstrates the modular structure:
//   - steps/  : Individual step functions
//   - index.ts: Combines steps into a complete flow
// ============================================================

import { test, expect } from '@playwright/test';
import { getApiContext, authHeaders } from '../fixtures/api-context';
import { TestDataManager } from '../fixtures/test-data';
import { pollUntil } from '../utils/poll-until';
import { login } from '../utils/auth';
import { requireEnv } from '../utils/require-env';

// ─────────────────────────────────────────────────────────────
// Step Functions
// ─────────────────────────────────────────────────────────────

export async function step_loginUser(email?: string, password?: string) {
  const apiContext = getApiContext();
  const result = await login(
    apiContext,
    email || requireEnv('TEST_EMAIL'),
    password || requireEnv('TEST_PASSWORD'),
  );
  return result;
}

export async function step_createOrder(token: string, userId: string, product: string, quantity: number) {
  const apiContext = getApiContext();
  const res = await apiContext.post('/orders', {
    headers: authHeaders({ Authorization: `Bearer ${token}` }),
    data: { userId, product, quantity },
  });
  expect(res.ok()).toBeTruthy();
  return res.json();
}

export async function step_getOrder(token: string, orderId: string) {
  const apiContext = getApiContext();
  const res = await apiContext.get(`/orders/${orderId}`, {
    headers: authHeaders({ Authorization: `Bearer ${token}` }),
  });
  expect(res.ok()).toBeTruthy();
  return res.json();
}

export async function step_pollOrderPaid(orderId: string) {
  const apiContext = getApiContext();
  return pollUntil(
    apiContext,
    `/orders/${orderId}`,
    (data) => data.status,
    ['PAID', 'COMPLETED'],
    { intervalMs: 2000, timeoutMs: 30000 }
  );
}

// ─────────────────────────────────────────────────────────────
// Complete Flow Test
// ─────────────────────────────────────────────────────────────

test('order flow: login → create order → poll until paid → verify', async () => {
  const manager = new TestDataManager(getApiContext());

  try {
    // Step 1: Login
    const { token, userId } = await step_loginUser();

    // Step 2: Create order
    const order = await step_createOrder(token, userId, 'SKU123', 2);
    await manager.create('orders', { id: order.orderId }); // track for cleanup
    expect(order.orderId).toBeDefined();
    expect(order.status).toBe('PENDING');

    // Step 3: Poll until paid (simulate payment)
    // In real tests, you might trigger payment here
    // await apiContext.post(`/orders/${order.orderId}/pay`);

    const paidOrder = await step_pollOrderPaid(order.orderId);
    expect(paidOrder.status).toBe('PAID');

    // Step 4: Verify final state
    const finalOrder = await step_getOrder(token, order.orderId);
    expect(finalOrder.status).toBe('PAID');

  } finally {
    await manager.cleanup();
  }
});