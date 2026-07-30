// ============================================================
// Test Data Manager Fixture
// ============================================================
// Lifecycle management for test data: create → use → cleanup
// Ensures all created resources are properly deleted after tests.
// ============================================================

import { APIRequestContext } from '@playwright/test';

interface Resource {
  type: string;
  id: string;
}

export class TestDataManager {
  private created: Resource[] = [];

  constructor(private apiContext: APIRequestContext) {}

  async create(type: string, data: Record<string, any>): Promise<string> {
    const res = await this.apiContext.post(`/${type}`, { data });
    if (!res.ok()) {
      throw new Error(`Failed to create ${type}: ${res.status()}`);
    }
    const { id } = await res.json();
    this.created.push({ type, id });
    return id;
  }

  async cleanup(): Promise<void> {
    // Delete in reverse order (handle dependencies)
    for (const { type, id } of this.created.reverse()) {
      await this.apiContext.delete(`/${type}/${id}`).catch(() => null);
    }
    this.created = [];
  }

  getCreated(): Resource[] {
    return [...this.created];
  }
}

// Usage:
//
// import { TestDataManager, getApiContext } from './fixtures/test-data';
//
// test('my test', async () => {
//   const manager = new TestDataManager(getApiContext());
//
//   try {
//     const userId = await manager.create('users', { name: 'Test' });
//     const orderId = await manager.create('orders', { userId });
//     // ... use test data
//   } finally {
//     await manager.cleanup();
//   }
// });
