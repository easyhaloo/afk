import type { View, ViewContext } from '../../lib/ui/core/types.js';

export interface DashboardStats {
  tasksActive: number;
  tasksCompleted: number;
  issuesOpen: number;
  projectsCount: number;
}

export const dashboardView: View = {
  id: 'dashboard',
  name: 'Dashboard',
  shortcut: '0',
  priority: 100,

  onMount(_ctx: ViewContext) {
    // stats integration will be added when StatsAggregator is wired up
  },

  render() {
    return null; // rendered by the Dashboard component in lib/dashboard/
  },
};
