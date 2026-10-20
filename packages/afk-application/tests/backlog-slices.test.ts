import { describe, expect, it, vi } from 'vitest';
import type {
  BacklogExecutionProvider,
  BacklogLifecycle,
  BacklogProvider,
  QABacklogProvider,
} from '../src/index.js';

/**
 * The slices exist so that a caller cannot reach a capability it was not
 * given.  The assertions below are the boundaries themselves: if a slice
 * grows to include what it was meant to exclude, the `@ts-expect-error`
 * stops being an error, the directive becomes unused, and the typecheck of
 * this file fails.
 */
function wholeProvider(): BacklogProvider {
  return {
    get: vi.fn(),
    adopt: vi.fn(),
    list: vi.fn(),
    create: vi.fn(),
    claim: vi.fn(),
    transition: vi.fn(),
    setExecutionMode: vi.fn(),
    createRework: vi.fn(),
    getActiveRework: vi.fn(),
    resolveRework: vi.fn(),
    addTag: vi.fn(),
    removeTag: vi.fn(),
    initialize: vi.fn(),
    isRunnable: vi.fn(),
  } as unknown as BacklogProvider;
}

describe('backlog provider slices', () => {
  it('the lifecycle writes the state and nothing else', () => {
    const provider = wholeProvider();
    const lifecycle: BacklogLifecycle = provider;

    expect(lifecycle.transition).toBe(provider.transition);
    expect(lifecycle.setExecutionMode).toBe(provider.setExecutionMode);

    // @ts-expect-error: a lifecycle may not claim work
    lifecycle.claim('42', 'runner');
    // @ts-expect-error: a lifecycle may not create a backlog item
    lifecycle.create({ title: 'x', description: '' });
    // @ts-expect-error: a lifecycle may not read the backlog
    lifecycle.get('42');
  });

  it('the execution surface may claim but not administer', () => {
    const provider = wholeProvider();
    const execution: BacklogExecutionProvider = provider;

    expect(execution.claim).toBe(provider.claim);
    expect(execution.getActiveRework).toBe(provider.getActiveRework);
    expect(execution.isRunnable).toBe(provider.isRunnable);

    // @ts-expect-error: a run does not create backlog items
    execution.create({ title: 'x', description: '' });
    // @ts-expect-error: a run does not own the tags
    execution.addTag('42', 'billing');
    // @ts-expect-error: a run does not provision provider metadata
    execution.initialize();
  });

  it('the QA surface may write rework records but never claim', () => {
    const provider = wholeProvider();
    const qa: QABacklogProvider = provider;

    expect(qa.createRework).toBe(provider.createRework);
    expect(qa.resolveRework).toBe(provider.resolveRework);

    // @ts-expect-error: QA never claims implementation work
    qa.claim('42', 'qa');
  });
});
