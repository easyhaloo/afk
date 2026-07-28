/**
 * View Registration - Register all built-in views
 */
import { ViewRegistry } from './index';

export function registerAllViews(): void {
  const registry = ViewRegistry.getInstance();

  registry.register({ name: 'tasks', label: 'tasks', icon: '●' });
  registry.register({ name: 'issues', label: 'issues', icon: '○' });
  registry.register({ name: 'completed', label: 'done', icon: '✔' });
  registry.register({ name: 'projects', label: 'projects', icon: '▸' });
  registry.register({ name: 'board', label: 'board', icon: '▦' });
}
