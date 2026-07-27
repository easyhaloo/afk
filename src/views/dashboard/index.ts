import type { View } from '../../lib/ui/core/types.js';

/**
 * Dashboard View — the main TUI entry point.
 * Wraps the existing Dashboard component as a registered View.
 */
export const dashboardView: View = {
  id: 'dashboard',
  name: 'Dashboard',
  shortcut: '0',
  priority: 100,

  onMount(_ctx) {
    // Dashboard initializes its own state from services
  },

  render() {
    // Lazy import to avoid circular deps during migration
    // This will be replaced with extracted sub-views in future
    return null; // rendered by Dashboard root component
  },
};
