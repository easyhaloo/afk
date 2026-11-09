import { Argument, Command, Option } from 'commander';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { GoogleOAuthCredentialProvider, GoogleOAuthError, configureGoogleAccountPlugins, PluginManager, readPluginConfiguration, builtinPluginManifests, createDefaultPluginRuntime, startPluginListener, startRemoteContainerService, invokeCapability, importManagedIssue, syncManagedIssue, managedIssueStateMapSchema, type PluginRuntime, type PluginConfigValue } from '@afk/runtime/plugin-sdk';
import { assembleProviders } from '@afk/runtime/infrastructure/provider/assembly';
import { parseCanonicalProject, parseWorkItemId } from '@afk/runtime/domain/work-item/identity';
import type { CommandRegistrationContext } from '../command-registry.js';

export interface PluginCommandComposition extends CommandRegistrationContext {
  createRuntime?: () => Promise<PluginRuntime>;
  pluginManager?: PluginManager;
  googleAuth?: Pick<GoogleOAuthCredentialProvider, 'login' | 'status' | 'logout'>;
  readConfiguration?: typeof readPluginConfiguration;
  assembleProviders?: typeof assembleProviders;
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
  plugin.command('import-issue <provider> <issue>')
    .description('Import an external tracker issue into a managed repository backlog')
    .requiredOption('--project <identity>', 'Canonical target repository, e.g. github:owner/repository')
    .addOption(new Option('--mode <mode>', 'Managed execution mode').choices(['hitl', 'afk']).default('hitl'))
    .option('--json', 'Emit JSON')
    .action(async (providerName, issueId, options) => {
      const project = parseCanonicalProject(options.project);
      const host = await runtime();
      const provider = host.getIssueTrackerProvider(providerName);
      if (!provider) throw new Error('External issue tracker provider is not available');
      const { providers } = await (composition.assembleProviders ?? assembleProviders)({
        platform: project.platform, projectKey: project.projectKey, cwd: process.cwd(), plugins: host,
      });
      const item = await importManagedIssue({ provider, issueId, project: options.project, backlog: providers.backlog, executionMode: options.mode });
      process.stdout.write(`${JSON.stringify(item, null, 2)}\n`);
    });
  plugin.command('sync-issue <provider> <issue> <work-item>')
    .description('Synchronize a bound external issue using an explicit managed-state mapping')
    .requiredOption('--states <path>', 'JSON mapping from managed lifecycle state to external state')
    .option('--json', 'Emit JSON')
    .action(async (providerName, issueId, workItemId, options) => {
      parseWorkItemId(workItemId);
      const states = managedIssueStateMapSchema.parse(await readJsonInput(options.states));
      const host = await runtime();
      const provider = host.getIssueTrackerProvider(providerName);
      if (!provider) throw new Error('External issue tracker provider is not available');
      const { providers } = await (composition.assembleProviders ?? assembleProviders)({ workItemId, cwd: process.cwd(), plugins: host });
      const item = await providers.backlog.get(workItemId);
      if (item.id !== workItemId) throw new Error('Managed issue identity conflicts with requested work item');
      process.stdout.write(`${JSON.stringify(await syncManagedIssue({ provider, issueId, item, states }), null, 2)}\n`);
    });
  const auth = plugin.command('auth').description('Manage provider authentication');
  for (const operation of ['login', 'status', 'logout'] as const) {
    const command = auth.command(operation)
      .description(`${operation} Google OAuth authentication`)
      .addArgument(new Argument('<provider>', 'Authentication provider').choices(['google']));
    if (operation === 'login') command.requiredOption('--client <path>', 'Google Desktop app OAuth client JSON file');
    command.action(async (_provider, options) => {
      const stop = new AbortController();
      const abort = () => stop.abort();
      process.once('SIGINT', abort);
      process.once('SIGTERM', abort);
      try {
        const credentials = composition.googleAuth ?? new GoogleOAuthCredentialProvider();
        if (operation === 'login') {
          process.stdout.write('Opening Google sign-in. Complete authorization within 10 minutes; keep this process running.\n');
          const account = await credentials.login(options.client, { signal: stop.signal });
          stop.signal.throwIfAborted();
          await configureGoogleAccountPlugins(manager, composition.readConfiguration);
          process.stdout.write(`Google connected: ${account.email}\nGmail notifications configured; no email sent.\n`);
        } else if (operation === 'status') {
          const status = await credentials.status();
          process.stdout.write(`${JSON.stringify({ connected: status.connected, email: status.email, expiresAt: status.expiresAt }, null, 2)}\n`);
        } else {
          await credentials.logout({ signal: stop.signal });
          process.stdout.write('Google disconnected.\n');
        }
      } catch (error) {
        const detail = error instanceof GoogleOAuthError ? ` (${error.code}): ${error.message}` : '';
        throw new Error(stop.signal.aborted ? 'Google authentication cancelled' : `Google ${operation} failed${detail}`);
      } finally {
        process.off('SIGINT', abort);
        process.off('SIGTERM', abort);
      }
    });
  }
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
      .action(async id => {
        const configuration = (composition.readConfiguration ?? readPluginConfiguration)();
        const builtin = builtinPluginManifests(homedir(), configuration.integrations).some(manifest => manifest.id === id);
        await manager.setEnabled(id, enabled, builtin);
        process.stdout.write(`${enabled ? 'Enabled' : 'Disabled'} ${id}\n`);
      });
  }
  plugin.command('remove <id>')
    .description('Disable and remove an installed plugin; retain its settings')
    .action(async id => { await manager.remove(id); process.stdout.write(`Removed ${id}\n`); });
  plugin.command('listen')
    .description('Run configured schedules and authenticated webhook triggers until stopped')
    .option('--host <address>', 'Listening address', '127.0.0.1')
    .option('--port <number>', 'Listening TCP port', Number, 8374)
    .option('--queue <path>', 'Durable trigger delivery database', join(homedir(), '.afk', 'triggers', 'deliveries.sqlite'))
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
        listener = await startPluginListener(host, { token, host: options.host, port: options.port, queuePath: options.queue });
        const address = listener.address;
        process.stdout.write(`Plugin listener ready at ${typeof address === 'object' && address ? `${address.address}:${address.port}` : address}\n`);
        if (!stop.signal.aborted) await new Promise<void>(resolve => stop.signal.addEventListener('abort', () => resolve(), { once: true }));
      } finally {
        process.off('SIGINT', abort);
        process.off('SIGTERM', abort);
        try { await listener?.close(); }
        finally { await host?.dispose(); }
      }
    });
  for (const operation of ['deliveries', 'replay', 'prune-deliveries'] as const) {
    const command = plugin.command(operation === 'replay' ? 'replay <delivery-id>' : operation)
      .description(operation === 'replay' ? 'Replay one failed durable trigger delivery' : operation === 'prune-deliveries' ? 'Remove successful deliveries older than the deduplication window' : 'Inspect durable trigger deliveries')
      .option('--url <url>', 'Running authenticated listener URL', 'http://127.0.0.1:8374')
      .requiredOption('--token-env <name>', 'Environment variable containing the listener token');
    if (operation === 'deliveries') command.option('--offset <number>', 'Receipt offset', '0').option('--limit <number>', 'Maximum receipts (1-100)', '100');
    command.action(async (...args: unknown[]) => {
      const deliveryId = operation === 'replay' ? String(args[0]) : undefined;
      if (deliveryId !== undefined && !/^[a-f0-9]{64}$/.test(deliveryId)) throw new Error('Invalid trigger delivery ID');
      const options = args[operation === 'replay' ? 1 : 0] as { url: string; tokenEnv: string; offset?: string; limit?: string };
      const token = process.env[options.tokenEnv];
      if (!token || token.length < 16 || /[\r\n]/.test(token)) throw new Error('Listener token must contain at least 16 characters');
      const endpoint = new URL(options.url);
      if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash
        || !(endpoint.protocol === 'https:' || (endpoint.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(endpoint.hostname)))) {
        throw new Error('Listener URL must use HTTPS or loopback HTTP without credentials, query, or fragment');
      }
      endpoint.pathname = operation === 'prune-deliveries' ? '/deliveries/prune' : deliveryId === undefined ? '/deliveries' : `/deliveries/${deliveryId}/replay`;
      if (operation === 'deliveries') {
        const offset = Number(options.offset);
        const limit = Number(options.limit);
        if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('Receipt pagination requires a nonnegative offset and limit from 1 to 100');
        endpoint.searchParams.set('offset', String(offset));
        endpoint.searchParams.set('limit', String(limit));
      }
      const response = await fetch(endpoint, {
        method: operation === 'deliveries' ? 'GET' : 'POST', headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(15_000), redirect: 'error',
      });
      if (!response.ok) throw new Error(`Listener ${operation} failed (HTTP ${response.status})`);
      process.stdout.write(`${JSON.stringify(await response.json(), null, 2)}\n`);
    });
  }
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
