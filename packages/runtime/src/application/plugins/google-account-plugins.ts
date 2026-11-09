import { PluginManager } from './manager.js';
import { readPluginConfiguration } from './configuration.js';

export async function configureGoogleAccountPlugins(
  manager: Pick<PluginManager, 'configure'> = new PluginManager(),
  readConfiguration: typeof readPluginConfiguration = readPluginConfiguration,
): Promise<void> {
  const configured = readConfiguration().plugins;
  await manager.configure('credential.google-oauth', {}, true);
  if (!configured.some(entry => entry.id === 'notification.gmail')) await manager.configure('notification.gmail', {}, true);
}
