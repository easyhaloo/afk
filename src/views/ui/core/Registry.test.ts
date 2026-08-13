import { describe, it, expect, beforeEach } from 'vitest';
import { ViewRegistry } from './Registry';
import type { View } from './types';

function makeView(overrides: Partial<View> = {}): View {
  return {
    id: 'test-view',
    name: 'Test View',
    shortcut: 't',
    priority: 0,
    render: () => null,
    ...overrides,
  };
}

describe('ViewRegistry', () => {
  let registry: ViewRegistry;

  beforeEach(() => {
    registry = new ViewRegistry();
  });

  describe('register / unregister', () => {
    it('registers a view', () => {
      registry.register(makeView({ id: 'v1', name: 'View 1' }));
      expect(registry.get('v1')?.name).toBe('View 1');
    });

    it('returns undefined for unregistered id', () => {
      expect(registry.get('nonexistent')).toBeUndefined();
    });

    it('unregisters a view', () => {
      registry.register(makeView({ id: 'v1' }));
      registry.unregister('v1');
      expect(registry.get('v1')).toBeUndefined();
    });

    it('clears active id when unregistering active view', () => {
      registry.register(makeView({ id: 'v1' }));
      registry.setActive('v1');
      registry.unregister('v1');
      expect(registry.getActive()).toBeUndefined();
    });
  });

  describe('getAll / sorting', () => {
    it('returns all views sorted by priority descending', () => {
      registry.register(makeView({ id: 'low', priority: 1 }));
      registry.register(makeView({ id: 'high', priority: 10 }));
      registry.register(makeView({ id: 'mid', priority: 5 }));
      const all = registry.getAll();
      expect(all.map(v => v.id)).toEqual(['high', 'mid', 'low']);
    });

    it('handles equal priority stably (insertion order not guaranteed)', () => {
      registry.register(makeView({ id: 'a', priority: 5 }));
      registry.register(makeView({ id: 'b', priority: 5 }));
      const ids = registry.getAll().map(v => v.id);
      expect(ids).toContain('a');
      expect(ids).toContain('b');
      expect(ids).toHaveLength(2);
    });
  });

  describe('active view', () => {
    it('sets and retrieves active view', () => {
      registry.register(makeView({ id: 'v1' }));
      registry.setActive('v1');
      expect(registry.getActive()?.id).toBe('v1');
    });

    it('setActive ignores unknown id', () => {
      registry.setActive('nonexistent');
      expect(registry.getActive()).toBeUndefined();
    });
  });
});
