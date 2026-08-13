import type { KeyboardEvent, KeyboardAPI } from './types';

/**
 * KeyboardDispatcher — routes keyboard events to the active View or global handlers.
 */
export class KeyboardDispatcher implements KeyboardAPI {
  private activeViewId: string | undefined;
  private globalHandlers = new Map<string, () => void>();

  setActiveView(id: string): void {
    this.activeViewId = id;
  }

  registerGlobal(key: string, handler: () => void): void {
    this.globalHandlers.set(key, handler);
  }

  dispatch(event: KeyboardEvent): void {
    // Global handlers first (Escape, Ctrl+C, etc.)
    if (event.key === 'escape' || event.key === 'ctrl-c') {
      const handler = this.globalHandlers.get(event.key);
      if (handler) { handler(); return; }
    }

    // Route to active view
    // The active view receives all events; it's responsible for handling its own shortcuts
    // This is a simple push model — more sophisticated priority-based routing can be added later
  }
}
