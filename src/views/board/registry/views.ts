/**
 * View Registration - Register all built-in views
 */
import { ViewRegistry } from './index';

export function registerAllViews(): void {
  const registry = ViewRegistry.getInstance();

  registry.register({ name: 'tasks', label: 'tasks', icon: '●' });
  registry.register({ name: 'backlogs', label: 'backlogs', icon: '○' });
  registry.register({ name: 'projects', label: 'projects', icon: '▸' });
  registry.register({ name: 'board', label: 'board', icon: '▦' });
}
