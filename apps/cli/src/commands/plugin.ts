import { Command } from 'commander';
import { readFile } from 'node:fs/promises';
import { PluginManager, createDefaultPluginRuntime, startPluginListener, startRemoteContainerService, invokeCapability, type PluginRuntime, type PluginConfigValue } from '@afk/runtime/plugin-sdk';
import type { CommandRegistrationContext } from '../command-registry.js';

export interface PluginCommandComposition extends CommandRegistrationContext {
  createRuntime?: () => Promise<PluginRuntime>;
  pluginManager?: PluginManager;
}

async function readJsonInput(path: string): Promise<unknown> {
  const text = await readFile(path, 'utf8');
  try { return JSON.parse(text); }
  catch { throw new Error('Plugin input file must contain valid JSON'); }
}

export function registerPluginCommands(program: Command, composition: PluginCommandComposition = {}): void {
  let runtimePromise: Promise<PluginRuntime> | undefined;
  const runtime = () => runtimePromise ??= composition.pluginRuntime
    ? Promise.resolve(composition.pluginRuntime)
    : composition.createRuntime
      ? composition.createRuntime()
      : import('../composition-root.js').then(module => module.createCliPluginRuntime());

  const manager = composition.pluginManager ?? new PluginManager();
  const plugin = program.command('plugin').description('Install, configure, and inspect capability plugins');
  plugin.command('serve-container')
    .description('Serve sandbox and agent operations to authenticated remote-container clients')
    .requiredOption('--repository <path>', 'Git repository used to create execution worktrees')
    .requiredOption('--workspace-root <path>', 'Existing directory bounding all remote execution worktrees')
    .requiredOption('--sandbox <provider>', 'Registered sandbox provider, for example docker or podman')
    .requiredOption('--agent <providers...>', 'Explicit allowlist of registered agent providers')
    .requiredOption('--token-env <name>', 'Environment variable containing a bearer token of at least 32 bytes')
    .option('--host <address>', 'Listening address', '127.0.0.1')
    .option('--port <number>', 'Listening TCP port', Number, 8375)
    .option('--allow-remote', 'Allow non-loopback clients and binding')
    .action(async options => {
      const token = process.env[options.tokenEnv];
      if (!token) throw new Error('The remote service token environment variable is not set');
      const stop = new AbortController();
      const abort = () => stop.abort();
      process.once('SIGINT', abort);
      process.once('SIGTERM', abort);
      let host: PluginRuntime | undefined;
      let service: Awaited<ReturnType<typeof startRemoteContainerService>> | undefined;
      try {
        host = await createDefaultPluginRuntime({ workspaceRoot: options.repository });
        service = await startRemoteContainerService(host, { token, repositoryRoot: options.repository, workspaceRoot: options.workspaceRoot, sandboxProviderId: options.sandbox, allowedAgents: options.agent, host: options.host, port: options.port, allowRemote: options.allowRemote });
        process.stdout.write(`Remote container service ready at ${service.address.address}:${service.address.port}\n`);
        if (!stop.signal.aborted) await new Promise<void>(resolve => stop.signal.addEventListener('abort', () => resolve(), { once: true }));
      } finally {
        process.off('SIGINT', abort);
        process.off('SIGTERM', abort);
        try { await service?.close(); } finally { await host?.dispose(); }
      }
    });
  plugin.command('invoke <capability> <provider> <operation>')
    .description('Call a typed capability operation with validated JSON input')
    .requiredOption('--input <path>', 'JSON operation input file')
    .option('--json', 'Emit JSON')
    .action(async (capability, provider, operation, options) => {
      const input = await readJsonInput(options.input);
      const result = await invokeCapability(await runtime(), { capability, provider, operation, input });
      process.stdout.write(`${JSON.stringify(result ?? null, null, 2)}\n`);
      if (result && typeof result === 'object' && (
        ('passed' in result && result.passed === false) || ('allowed' in result && result.allowed === false)
        || ('delivered' in result && result.delivered === false) || ('code' in result && typeof result.code === 'number' && result.code !== 0)
      )) process.exitCode = 1;
    });
  plugin.command('install <source>')
    .description('Install a trusted local directory or npm package with isolated dependencies')
    .action(async source => {
      const installed = await manager.install(source);
      process.stdout.write(`Installed ${installed.id}@${installed.version}\n`);
    });
  plugin.command('configure <id>')
    .description('Save validated plugin settings from a JSON file')
    .requiredOption('--file <path>', 'JSON settings file; use environment references for secrets')
    .option('--builtin', 'Configure a bundled capability provider')
    .option('--action <name>', 'System action to dispatch when configured triggers fire')
    .action(async (id, options) => {
      const parsed = await readJsonInput(options.file);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Plugin settings must be a JSON object');
      await manager.configure(id, parsed as { [key: string]: PluginConfigValue }, options.builtin ?? false, options.action);
      process.stdout.write(`Configured ${id}\n`);
    });
  for (const [command, enabled] of [['enable', true], ['disable', false]] as const) {
    plugin.command(`${command} <id>`)
      .description(`${enabled ? 'Enable' : 'Disable'} a capability plugin`)
      .action(async id => { await manager.setEnabled(id, enabled, !!(await runtime()).getPlugin(id)); process.stdout.write(`${enabled ? 'Enabled' : 'Disabled'} ${id}\n`); });
  }
  plugin.command('remove <id>')
    .description('Disable and remove an installed plugin; retain its settings')
    .action(async id => { await manager.remove(id); process.stdout.write(`Removed ${id}\n`); });
  plugin.command('listen')
    .description('Run configured schedules and authenticated webhook triggers until stopped')
    .option('--host <address>', 'Listening address', '127.0.0.1')
    .option('--port <number>', 'Listening TCP port', Number, 8374)
    .requiredOption('--token-env <name>', 'Environment variable containing the webhook authentication secret')
    .action(async options => {
      const token = process.env[options.tokenEnv];
      if (!token) throw new Error('The listener token environment variable is not set');
      const stop = new AbortController();
      const abort = () => stop.abort();
      process.once('SIGINT', abort);
      process.once('SIGTERM', abort);
      let host: PluginRuntime | undefined;
      let listener: Awaited<ReturnType<typeof startPluginListener>> | undefined;
      try {
        host = await createDefaultPluginRuntime({ activateTriggers: true, warn: message => process.stderr.write(`${message}\n`) });
        if ((await host.diagnostics()).some(diagnostic => diagnostic.severity === 'error')) throw new Error('Plugin listener configuration failed validation; run plugin doctor for details');
        listener = await startPluginListener(host, { token, host: options.host, port: options.port });
        const address = listener.address;
        process.stdout.write(`Plugin listener ready at ${typeof address === 'object' && address ? `${address.address}:${address.port}` : address}\n`);
        if (!stop.signal.aborted) await new Promise<void>(resolve => stop.signal.addEventListener('abort', () => resolve(), { once: true }));
      } finally {
        process.off('SIGINT', abort);
        process.off('SIGTERM', abort);
        await listener?.close();
        await host?.dispose();
      }
    });
  plugin.command('list')
    .description('List loaded plugins and capabilities')
    .option('--json', 'Emit JSON')
    .action(async options => {
      const host = await runtime();
      const rows = host.listPlugins().map(id => ({
        id,
        capabilities: host.listCapabilities().filter(capability => host.getPlugin(id)?.manifest.provides.includes(capability)),
        providers: host.listProvidersForPlugin(id),
      }));
      if (options.json) process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
      else process.stdout.write(rows.length ? `${rows.map(row => `${row.id} — ${row.capabilities.join(', ') || 'no declared capabilities'}`).join('\n')}\n` : 'No plugins loaded.\n');
    });

  plugin.command('doctor')
    .description('Run health and diagnostics for loaded plugins')
    .option('--plugin <id>', 'Limit checks to one plugin')
    .option('--json', 'Emit JSON')
    .action(async options => {
      const host = await runtime();
      const report = { health: await host.health(options.plugin), diagnostics: await host.diagnostics(options.plugin) };
      if (options.plugin && !host.getPlugin(options.plugin) && !report.diagnostics.length) {
        report.diagnostics = [{ pluginId: options.plugin, severity: 'error', code: 'plugin.not-found', message: 'Plugin is not loaded' }];
      }
      if (report.health.some(result => result.status === 'unhealthy') || report.diagnostics.some(result => result.severity === 'error')) process.exitCode = 1;
      if (options.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      else {
        for (const result of report.health) process.stdout.write(`${result.pluginId ?? 'plugin'}: ${result.status}${result.message ? ` — ${result.message}` : ''}\n`);
        for (const diagnostic of report.diagnostics) process.stdout.write(`${diagnostic.severity.toUpperCase()} ${diagnostic.pluginId ?? 'plugin'} ${diagnostic.code}: ${diagnostic.message}\n`);
      }
    });
}
