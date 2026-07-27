import type { View, RegistryAPI } from './types.js';

/**
 * ViewRegistry — manages View registration and active view state.
 * Views are sorted by priority (descending) so built-ins win over plugins.
 */
export class ViewRegistry implements RegistryAPI {
  private views = new Map<string, View>();
  private _activeId: string | undefined;

  register(view: View): void {
    this.views.set(view.id, view);
  }

  unregister(id: string): void {
    this.views.delete(id);
    if (this._activeId === id) {
      this._activeId = undefined;
    }
  }

  get(id: string): View | undefined {
    return this.views.get(id);
  }

  getAll(): View[] {
    return Array.from(this.views.values()).sort((a, b) => b.priority - a.priority);
  }

  getActive(): View | undefined {
    return this._activeId ? this.views.get(this._activeId) : undefined;
  }

  setActive(id: string): void {
    if (this.views.has(id)) {
      this._activeId = id;
    }
  }
}
