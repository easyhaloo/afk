import { APIRequestContext } from '@playwright/test';

interface Resource {
  type: string;
  id: string;
}

/**
 * Tracks resources created by a workflow and cleans them up in reverse order.
 * Endpoint shapes and deletion requirements must come from the target application.
 */
export class TestDataManager {
  private created: Resource[] = [];

  constructor(private readonly apiContext: APIRequestContext) {}

  track(type: string, id: string): void {
    this.created.push({ type, id });
  }

  async create(type: string, data: Record<string, unknown>): Promise<string> {
    const response = await this.apiContext.post(`/${type}`, { data });
    if (!response.ok()) {
      throw new Error(`Failed to create ${type}: ${response.status()}`);
    }

    const body = (await response.json()) as { id?: string };
    if (!body.id) {
      throw new Error(`Create ${type} response did not contain an id`);
    }

    this.track(type, body.id);
    return body.id;
  }

  async cleanup(): Promise<void> {
    for (const { type, id } of [...this.created].reverse()) {
      try {
        await this.apiContext.delete(`/${type}/${id}`);
      } catch {
        // Cleanup is best-effort; report cleanup failures from the owning test when needed.
      }
    }
    this.created = [];
  }

  getCreated(): Resource[] {
    return [...this.created];
  }
}
