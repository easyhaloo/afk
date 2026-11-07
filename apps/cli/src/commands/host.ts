import { Command } from 'commander';
import { createHostApplication } from '@afk/application';
import { HostFailure } from '@afk/core';
import type { PluginRuntime } from '@afk/runtime/plugin-sdk';
import type { CommandRegistrationContext } from '../command-registry.js';

export interface HostCommandComposition extends CommandRegistrationContext {
  createRuntime?: () => Promise<PluginRuntime>;
}

function duration(value: string): number {
  const match = /^(\d+)(ms|s|m)?$/.exec(value.trim());
  if (!match) throw new Error(`invalid timeout '${value}'`);
  const amount = Number(match[1]);
  return amount * (match[2] === 'm' ? 60_000 : match[2] === 's' ? 1_000 : 1);
}

function provider(runtime: PluginRuntime, name: string) {
  const connection = runtime.getHostProvider(name);
  if (!connection) throw new Error(`host provider '${name}' is not installed`);
  return createHostApplication(connection);
}

function printFailure(error: unknown, json: boolean): void {
  const failure = error instanceof HostFailure
    ? { code: error.code, message: error.message, suggestion: error.suggestion }
    : { code: 'host-failed', message: error instanceof Error ? error.message : String(error) };
  if (json) process.stdout.write(`${JSON.stringify({ ok: false, error: failure })}\n`);
  else process.stderr.write(`Error: ${failure.message}${'suggestion' in failure ? `\nHint: ${failure.suggestion}` : ''}\n`);
  process.exitCode = 1;
}

export function registerHostCommands(program: Command, composition: HostCommandComposition = {}): void {
  let runtimePromise: Promise<PluginRuntime> | undefined;
  const runtime = () => runtimePromise ??= composition.pluginRuntime
    ? Promise.resolve(composition.pluginRuntime)
    : composition.createRuntime
      ? composition.createRuntime()
      : import('../composition-root.js').then(module => module.createCliPluginRuntime());

  const host = program.command('host').description('Manage remote hosts through installed providers');
  host.command('ls')
    .description('List hosts exposed by a provider')
    .option('--provider <name>', 'Host provider', 'jumpserver')
    .option('--json', 'Emit JSON')
    .action(async options => {
      try {
        const app = provider(await runtime(), options.provider);
        const hosts = await app.listHosts();
        if (options.json) process.stdout.write(`${JSON.stringify(hosts, null, 2)}\n`);
        else process.stdout.write(hosts.length ? `${hosts.map(host => `${host.alias} [${host.provider}]${host.address ? ` ${host.address}` : ''}`).join('\n')}\n` : 'No hosts found.\n');
      } catch (error) { printFailure(error, options.json); }
    });

  host.command('exec')
    .description('Execute an argv vector on a remote host')
    .argument('<host>', 'Host alias or provider-specific target')
    .argument('<argv...>', 'Remote command and arguments')
    .option('--provider <name>', 'Host provider', 'jumpserver')
    .option('--timeout <duration>', 'Timeout, for example 15s or 2m')
    .option('--json', 'Emit JSON')
    .action(async (target, argv, options) => {
      try {
        const app = provider(await runtime(), options.provider);
        const result = await app.exec({ host: target, argv, timeoutMs: options.timeout ? duration(options.timeout) : undefined });
        if (options.json) process.stdout.write(`${JSON.stringify({ ok: result.code === 0, result })}\n`);
        else {
          if (result.stdout) process.stdout.write(result.stdout);
          if (result.stderr) process.stderr.write(result.stderr);
        }
        if (result.code !== 0) process.exitCode = result.code || 1;
      } catch (error) { printFailure(error, options.json); }
    });
}
