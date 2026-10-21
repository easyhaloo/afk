import { describe, expect, it, vi } from 'vitest';
import type { BacklogItem, BacklogManagementProvider } from '@afk/application';

/**
 * The application package owns the backlog vocabulary: which states a work
 * item can be in, and which execution modes it can carry. The CLI is a
 * consumer of that vocabulary, not a second authority on it.
 *
 * This test grows the vocabulary the application package publishes and then
 * asks the CLI whether it grew with it. A CLI that keeps its own copy of the
 * lists rejects the new value, and that rejection is the defect: the CLI
 * answers "which modes exist" differently from the package that owns the
 * answer.
 */
vi.mock('@afk/application', async importOriginal => {
  const original = await importOriginal<typeof import('@afk/application')>();
  return {
    ...original,
    BACKLOG_STATES: [...original.BACKLOG_STATES, 'paused'],
    BACKLOG_EXECUTION_MODES: [...original.BACKLOG_EXECUTION_MODES, 'auto'],
  };
});

import { BACKLOG_EXECUTION_MODES, BACKLOG_STATES } from '@afk/application';
import {
  runBacklogCreate,
  runBacklogInventory,
  runBacklogList,
} from '../../src/cli/commands/backlog';

function stubItem(overrides: Partial<BacklogItem> = {}): BacklogItem {
  return {
    id: '42',
    title: 'demo',
    description: 'demo',
    dependsOn: [],
    state: 'ready',
    executionMode: 'afk',
    tags: [],
    branchName: 'afk/backlog-42',
    providerRef: 'stub:42',
    webUrl: 'https://example.test/42',
    ...overrides,
  };
}

function stubProvider(): BacklogManagementProvider {
  return {
    get: vi.fn(async () => stubItem()),
    list: vi.fn(async () => [stubItem()]),
    create: vi.fn(async (input) => stubItem({ id: 'new', title: input.title })),
    addTag: vi.fn(async () => undefined),
    removeTag: vi.fn(async () => undefined),
    initialize: vi.fn(async () => undefined),
  };
}

describe('The CLI answers with the backlog vocabulary the application publishes', () => {
  it('lists by every execution mode the application declares', async () => {
    for (const mode of BACKLOG_EXECUTION_MODES) {
      await expect(runBacklogList(stubProvider(), { mode })).resolves.toBeUndefined();
    }
  });

  it('lists by every state the application declares', async () => {
    for (const state of BACKLOG_STATES) {
      await expect(runBacklogList(stubProvider(), { state })).resolves.toBeUndefined();
    }
  });

  it('filters the global inventory by every state and mode the application declares', async () => {
    for (const state of BACKLOG_STATES) {
      await expect(runBacklogInventory(() => [], { state })).resolves.toBeUndefined();
    }
    for (const mode of BACKLOG_EXECUTION_MODES) {
      await expect(runBacklogInventory(() => [], { mode })).resolves.toBeUndefined();
    }
  });

  it('creates a work item in every execution mode the application declares', async () => {
    for (const mode of BACKLOG_EXECUTION_MODES) {
      await expect(
        runBacklogCreate(stubProvider(), { title: 'fresh', description: 'fresh', mode }),
      ).resolves.toBeUndefined();
    }
  });

  it('refuses a mode the application does not declare', async () => {
    await expect(runBacklogList(stubProvider(), { mode: 'manual' })).rejects.toThrow(
      /invalid execution mode/,
    );
  });

  it('refuses a state the application does not declare', async () => {
    await expect(runBacklogList(stubProvider(), { state: 'archived' })).rejects.toThrow(
      /invalid backlog state/,
    );
  });
});
